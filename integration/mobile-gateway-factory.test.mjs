import test from 'node:test'
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { NativeTlsManager } from './native-tls-manager.mjs'
import { createIrohGatewayFactory } from './mobile-gateway-factory.mjs'
import { createSidecarFixtureRoot, firstPartyExecutable } from '../src/first-party-fixture.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))

function publicGatewayFixture() {
  const calls = { starts: 0, closes: 0, refreshes: 0, failRefresh: false, failStart: false, failClose: false }
  class Gateway {
    constructor(config, store, extensions, upstreamAuthenticatedUrl) { Object.assign(calls, { config, store, extensions, upstreamAuthenticatedUrl }) }
    async start() { calls.starts += 1; if (calls.failStart) throw new Error('private-start-sentinel') }
    async close() { calls.closes += 1; if (calls.failClose) throw new Error('private-close-sentinel') }
    async refreshProvidedTls() { calls.refreshes += 1; if (calls.failRefresh) throw new Error('private-refresh-sentinel') }
    address() { return { port: 25445 } }
  }
  return { calls, mobile: { parseGatewayConfig: config => config, MobileAccessGateway: Gateway, JsonDeviceStore: class { constructor(path) { this.path = path } } } }
}

async function tlsFixture(context, run) {
  try { await access(firstPartyExecutable) } catch { context.skip('build first-party host for Gateway native TLS tests'); return }
  const owned = await createSidecarFixtureRoot('gateway-managed-tls')
  const manager = new NativeTlsManager({ executable: firstPartyExecutable, dataDirectory: join(owned.directory, 'host') })
  let backend
  try {
    const prepared = await manager.prepare()
    const fixture = publicGatewayFixture()
    const options = { mobile: fixture.mobile, endpointId: prepared.endpointId, localPort: 25445,
      upstreamOrigin: 'http://127.0.0.1:25446', stateFile: join(owned.directory, 'devices.json'), tlsManager: manager }
    await run({ manager, prepared, ...fixture, options, setBackend: value => { backend = value } })
  } finally { await backend?.close(); await manager.close(); await owned.cleanup() }
}

test('factory provisions automatically and forwards only the public extension service', async context => tlsFixture(context, async ({ manager, prepared, calls, options, setBackend }) => {
  const service = Object.freeze({ marker: 'public-service' })
  const backend = await createIrohGatewayFactory({ ...options, extensionHost: { service }, upstreamAuthenticatedUrl: 'http://127.0.0.1/authenticated' })()
  setBackend(backend)
  assert.equal(calls.extensions, service); assert.equal(calls.config.tls.certFile, prepared.tls.certFile)
  assert.equal(backend.tlsStatus().managed, true); assert.equal(backend.tlsStatus().state, 'ready')
  const first = backend.tlsStatus()
  const renewed = await backend.renewTls()
  assert.equal(calls.starts, 1); assert.equal(calls.refreshes, 1); assert.equal(calls.closes, 0)
  assert.notEqual(renewed.leafFingerprint256, first.leafFingerprint256)
  assert.equal(renewed.instanceId, first.instanceId); assert.equal(backend.instanceId, prepared.instanceId)
  await backend.close(); assert.equal(calls.closes, 1)
  assert.equal(manager.status().state, 'ready', 'external manager remains owned by the caller')
  await assert.rejects(backend.renewTls(), /owner_closed/u)
}))

test('failed public refresh retains active certificate metadata and supports explicit retry', async context => tlsFixture(context, async ({ calls, options, setBackend }) => {
  const backend = await createIrohGatewayFactory(options)(); setBackend(backend)
  const active = backend.tlsStatus(); calls.failRefresh = true
  await assert.rejects(backend.renewTls(), error => error.message === 'iroh_tls_renewal_failed' && !String(error).includes('private-refresh-sentinel'))
  assert.equal(backend.tlsStatus().state, 'error')
  assert.equal(backend.tlsStatus().leafFingerprint256, active.leafFingerprint256)
  assert.equal(calls.starts, 1); assert.equal(calls.closes, 0)
  calls.failRefresh = false
  const retry = await backend.renewTls()
  assert.equal(retry.state, 'ready'); assert.notEqual(retry.leafFingerprint256, active.leafFingerprint256)
  assert.equal(retry.caFingerprint256, active.caFingerprint256); assert.equal(calls.starts, 1)
}))

test('close withdraws renewal and drains it before closing Gateway without closing external manager', async context => tlsFixture(context, async ({ manager, prepared, calls, options, setBackend }) => {
  let release, signal
  const gate = new Promise(resolve => { release = resolve })
  const tlsManager = { withPrepared: (opts, activate) => manager.withPrepared(opts, activate),
    async withRenewed(opts, activate) { signal = opts.signal; await gate; return activate(prepared, signal) } }
  const backend = await createIrohGatewayFactory({ ...options, tlsManager })(); setBackend(backend)
  const renewing = backend.renewTls(), rejected = assert.rejects(renewing, /renewal_failed/u)
  await tick(); const closing = backend.close(); await tick()
  assert.equal(signal.aborted, true); assert.equal(calls.closes, 0); assert.equal(calls.refreshes, 0)
  release(); await rejected; await closing
  assert.equal(calls.closes, 1); assert.equal(calls.refreshes, 0)
}))

test('configured timer renews and disappears on owner close', async context => tlsFixture(context, async ({ manager, calls, options, setBackend }) => {
  let triggered
  const started = new Promise(resolve => { triggered = resolve })
  const tlsManager = { withPrepared: (opts, activate) => manager.withPrepared(opts, activate),
    withRenewed(opts, activate) { triggered(); return manager.withRenewed(opts, activate) } }
  const backend = await createIrohGatewayFactory({ ...options, tlsManager, tlsCheckIntervalMs: 20, tlsRenewBeforeMs: 100 * 24 * 60 * 60 * 1000 })()
  setBackend(backend)
  let deadline
  try { await Promise.race([started, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('renewal timer did not run')), 1000) })]) }
  finally { clearTimeout(deadline) }
  await backend.close()
  const refreshes = calls.refreshes
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(calls.refreshes, refreshes); assert.equal(calls.starts, 1); assert.equal(calls.closes, 1)
}))

test('cancelled prepare cannot start a late Gateway', async context => tlsFixture(context, async ({ manager, calls, options }) => {
  const abort = new AbortController()
  const tlsManager = { withPrepared: (opts, activate) => manager.withPrepared(opts, (metadata, signal) => { abort.abort(); return activate(metadata, signal) }),
    withRenewed: (opts, activate) => manager.withRenewed(opts, activate) }
  await assert.rejects(createIrohGatewayFactory({ ...options, tlsManager, signal: abort.signal })(), /cancelled|activation_failed/u)
  assert.equal(calls.starts, 0); assert.equal(calls.closes, 0)
}))

test('startup plus cleanup failure retains a nonenumerable retryable Gateway owner', async context => tlsFixture(context, async ({ calls, options }) => {
  calls.failStart = true; calls.failClose = true
  let failure
  await assert.rejects(createIrohGatewayFactory(options)(), error => { failure = error; return error instanceof AggregateError })
  assert.equal(typeof failure.gatewayCleanup?.close, 'function')
  assert.equal(Object.keys(failure).includes('gatewayCleanup'), false)
  assert.equal(JSON.stringify(failure), '{}')
  await assert.rejects(failure.gatewayCleanup.close(), /close-sentinel/u)
  calls.failClose = false
  await failure.gatewayCleanup.close()
  const closes = calls.closes; await failure.gatewayCleanup.close(); assert.equal(calls.closes, closes)
  assert.equal(calls.starts, 1)
}))

test('failed release after successful activation retains the live backend when its close fails', async context => tlsFixture(context, async ({ manager, calls, options }) => {
  const tlsManager = { async withPrepared(opts, activate) {
    await manager.withPrepared(opts, activate)
    throw new Error('private-release-sentinel')
  }, withRenewed: (opts, activate) => manager.withRenewed(opts, activate) }
  calls.failClose = true
  let failure
  await assert.rejects(createIrohGatewayFactory({ ...options, tlsManager })(), error => { failure = error; return error instanceof AggregateError })
  assert.equal(typeof failure.gatewayCleanup?.close, 'function'); assert.equal(calls.starts, 1)
  assert.equal(JSON.stringify(failure).includes('private-release-sentinel'), false)
  calls.failClose = false
  await failure.gatewayCleanup.close()
  assert.equal(manager.status().state, 'ready')
}))
