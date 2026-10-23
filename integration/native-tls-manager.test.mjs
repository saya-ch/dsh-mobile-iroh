import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { access } from 'node:fs/promises'
import { NativeTlsError, NativeTlsManager } from './native-tls-manager.mjs'
import { createSidecarFixtureRoot, firstPartyExecutable } from '../src/first-party-fixture.mjs'
import { irohHostname } from './origin-contract.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const endpointId = 'a'.repeat(64)
const dataDirectory = resolve('unused-tls-profile')
const hasCode = code => error => error instanceof NativeTlsError && error.code === code
const metadata = (extra = {}) => ({ version: 1, endpointId, hostname: irohHostname(endpointId), instanceId: 'b'.repeat(64),
  caFingerprint256: 'b'.repeat(64), leafFingerprint256: 'c'.repeat(64), caValidTo: 2000000000000, leafValidTo: 1900000000000,
  tls: { caFile: join(dataDirectory, 'tls/ca.pem'), certFile: join(dataDirectory, 'tls/server.pem'), keyFile: join(dataDirectory, 'tls/server-key.pem') }, ...extra })

function childProcess({ killCloses = true } = {}) {
  const child = new EventEmitter()
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = []
  child.close = (code = 0, signal = null) => { child.emit('close', code, signal) }
  child.kill = (signal = 'SIGTERM') => { child.kills.push(signal); if (killCloses) queueMicrotask(() => child.close(null, signal)); return true }
  return child
}
const options = (spawnImpl, extra = {}) => ({ executable: resolve('host.exe'), dataDirectory, spawnImpl, timeoutMs: 1000, stopTimeoutMs: 15, ...extra })
const respond = (child, value = metadata()) => { child.stdout.write(`${JSON.stringify(value)}\n`); child.close() }

test('TLS commands serialize fixed native operations and settle only after actual close', async () => {
  const children = [], calls = []
  const manager = new NativeTlsManager(options((file, args, spawned) => {
    const child = childProcess(); children.push(child); calls.push({ file, args, spawned }); return child
  }))
  assert.equal(manager.status().state, 'unprepared')
  const first = manager.prepare({ endpointId }), second = manager.renew({ endpointId })
  await tick(); assert.equal(children.length, 1)
  let settled = false; void first.then(() => { settled = true })
  children[0].stdout.write(`${JSON.stringify(metadata())}\n`); children[0].emit('exit', 0, null)
  await tick(); assert.equal(settled, false)
  children[0].close(); assert.deepEqual(await first, metadata())
  await tick(); assert.equal(children.length, 2); respond(children[1]); await second
  assert.deepEqual(calls[0].args, ['--lang', 'en', 'tls-prepare', '--data-dir', dataDirectory, '--leaf-validity-days', '90', '--renew-before-days', '30'])
  assert.equal(calls[1].args[2], 'tls-renew'); assert.equal(calls[0].spawned.windowsHide, true)
  assert.deepEqual(calls[0].spawned.stdio, ['ignore', 'pipe', 'pipe'])
  assert.equal(manager.status().tls, undefined); assert.equal(manager.status().state, 'ready')
  await manager.close(); assert.equal(manager.status().state, 'closed')
})

test('metadata rejects unknown fields, another endpoint, arbitrary paths, invalid expiry and encoding', async () => {
  for (const value of [metadata({ unknown: true }), metadata({ endpointId: 'd'.repeat(64) }), metadata({ leafValidTo: 2100000000000 }),
    metadata({ tls: { ...metadata().tls, keyFile: resolve('outside.key') } }), metadata({ instanceId: 'd'.repeat(64) }),
    metadata({ hostname: 'short.iroh.localhost' })]) {
    const child = childProcess(), manager = new NativeTlsManager(options(() => child))
    const pending = manager.prepare({ endpointId }); await tick(); respond(child, value)
    await assert.rejects(pending, hasCode('invalid_tls_response')); await manager.close()
  }
  for (const output of [Buffer.from([0xff, 10]), `${JSON.stringify(metadata())}\n\n`, JSON.stringify(metadata()),
    `${JSON.stringify(metadata())}\n${JSON.stringify(metadata())}\n`]) {
    const child = childProcess(), manager = new NativeTlsManager(options(() => child))
    const pending = manager.prepare(); await tick(); child.stdout.write(output); child.close()
    await assert.rejects(pending, hasCode('invalid_tls_response')); await manager.close()
  }
})

test('bounded output and stderr are discarded and termination waits for actual close', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const child = childProcess({ killCloses: false }), manager = new NativeTlsManager(options(() => child, { stopTimeoutMs: 100 }))
    const pending = manager.prepare(), rejected = assert.rejects(pending, error => hasCode('tls_output_too_large')(error) && !String(error).includes('private-sentinel'))
    await tick(); child[stream].write('private-sentinel'.repeat(1000)); await tick()
    assert.deepEqual(child.kills, ['SIGTERM']); child.close(null, 'SIGTERM'); await rejected; await manager.close()
  }
})

test('cancellation and owner close cancel accepted work but not its possible committed disk outcome', async () => {
  const child = childProcess({ killCloses: false }), abort = new AbortController()
  const manager = new NativeTlsManager(options(() => child, { stopTimeoutMs: 100 }))
  const pending = manager.renew({ signal: abort.signal }), rejected = assert.rejects(pending, hasCode('tls_operation_cancelled'))
  await tick(); abort.abort(); await tick(); assert.deepEqual(child.kills, ['SIGTERM'])
  child.emit('exit', null, 'SIGTERM'); await tick()
  let closed = false; const closing = manager.close().then(() => { closed = true })
  await tick(); assert.equal(closed, false)
  child.close(null, 'SIGTERM'); await rejected; await closing
  await assert.rejects(manager.prepare(), hasCode('tls_manager_closed'))
})

test('failed termination remains owned and explicit close can retry after real exit', async () => {
  const child = childProcess({ killCloses: false }), manager = new NativeTlsManager(options(() => child, { timeoutMs: 10, stopTimeoutMs: 10 }))
  await assert.rejects(manager.prepare(), hasCode('tls_process_not_closed'))
  await assert.rejects(manager.prepare(), hasCode('tls_process_not_closed'))
  await assert.rejects(manager.close(), hasCode('tls_process_not_closed'))
  child.close(null, 'SIGKILL'); await manager.close()
})

test('queued aborted requests do not spawn and policy errors are rejected before side effects', async () => {
  const children = []
  const manager = new NativeTlsManager(options(() => { const child = childProcess(); children.push(child); return child }))
  const first = manager.prepare(), abort = new AbortController(), next = manager.renew({ signal: abort.signal })
  const rejected = assert.rejects(next, hasCode('tls_operation_cancelled'))
  abort.abort(); await tick(); respond(children[0]); await first; await rejected
  assert.equal(children.length, 1); await manager.close()
  for (const extra of [{ leafValidityDays: 366 }, { renewBeforeDays: 90 }, { dataDirectory: 'relative' }, { timeoutMs: 0 }]) {
    assert.throws(() => new NativeTlsManager(options(() => { throw new Error('must not spawn') }, extra)), hasCode('invalid_tls_manager_options'))
  }
})

test('real native provisioning retains CA and identity across owners while rotating only leaf', async context => {
  try { await access(firstPartyExecutable) } catch { context.skip('build the first-party host for native integration'); return }
  const owned = await createSidecarFixtureRoot('native-tls-manager'), managers = []
  const directory = join(owned.directory, 'host')
  try {
    const first = new NativeTlsManager({ executable: firstPartyExecutable, dataDirectory: directory }); managers.push(first)
    const prepared = await first.prepare(); await first.close()
    const second = new NativeTlsManager({ executable: firstPartyExecutable, dataDirectory: directory }); managers.push(second)
    const stable = await second.prepare({ endpointId: prepared.endpointId })
    const renewed = await second.renew({ endpointId: prepared.endpointId })
    assert.equal(prepared.instanceId, renewed.instanceId); assert.equal(prepared.endpointId, renewed.endpointId)
    assert.equal(prepared.caFingerprint256, renewed.caFingerprint256)
    assert.equal(prepared.leafFingerprint256, stable.leafFingerprint256); assert.notEqual(stable.leafFingerprint256, renewed.leafFingerprint256)
    assert.deepEqual((await second.inspect()).tls, prepared.tls)
    assert.equal(JSON.stringify(second.status()).includes('PRIVATE KEY'), false)
  } finally { await Promise.all(managers.map(manager => manager.close())); await owned.cleanup() }
})

test('concurrent real native first-install processes cannot create divergent CA or endpoint state', async context => {
  try { await access(firstPartyExecutable) } catch { context.skip('build the first-party host for native integration'); return }
  const owned = await createSidecarFixtureRoot('native-tls-concurrent')
  const directory = join(owned.directory, 'host')
  const managers = Array.from({ length: 4 }, () => new NativeTlsManager({ executable: firstPartyExecutable, dataDirectory: directory }))
  try {
    const results = await Promise.allSettled(managers.map(manager => manager.prepare()))
    const succeeded = results.filter(result => result.status === 'fulfilled').map(result => result.value)
    assert.ok(succeeded.length >= 1)
    const final = await managers[0].prepare()
    for (const value of succeeded) {
      assert.equal(value.instanceId, final.instanceId); assert.equal(value.endpointId, final.endpointId)
      assert.equal(value.caFingerprint256, final.caFingerprint256)
      assert.equal(value.leafFingerprint256, final.leafFingerprint256)
    }
    for (const result of results.filter(result => result.status === 'rejected')) assert.ok(hasCode('tls_process_failed')(result.reason))
  } finally { await Promise.all(managers.map(manager => manager.close())); await owned.cleanup() }
})

test('held activation retains the process lease until callback completion and actual child close', async () => {
  const child = childProcess(), calls = []
  let release, activated = false
  const gate = new Promise(resolve => { release = resolve })
  const manager = new NativeTlsManager(options((_file, args, spawned) => { calls.push({ args, spawned }); return child }))
  const result = manager.withPrepared({ endpointId }, async (prepared, signal) => {
    activated = true; assert.deepEqual(prepared, metadata()); assert.equal(signal.aborted, false)
    await gate; assert.equal(signal.aborted, false); return 'installed'
  })
  await tick(); child.stdout.write(`${JSON.stringify(metadata())}\n`); await tick()
  assert.equal(activated, true); assert.equal(calls[0].args.at(-1), '--hold')
  assert.equal(calls[0].spawned.stdio[0], 'pipe'); assert.equal(child.stdin.read(), null)
  let settled = false; void result.then(() => { settled = true })
  release(); await tick(); assert.equal(child.stdin.read().toString(), '{"version":1,"type":"tls-release"}\n')
  child.emit('exit', 0, null); await tick(); assert.equal(settled, false)
  child.close(); assert.equal(await result, 'installed'); await manager.close()
})

test('held callback sees abort and is drained before an unexpected native close releases Node ownership', async () => {
  const child = childProcess({ killCloses: false })
  let release, activationSignal, completed = false
  const gate = new Promise(resolve => { release = resolve })
  const manager = new NativeTlsManager(options(() => child))
  const result = manager.withRenewed({}, async (_prepared, signal) => { activationSignal = signal; await gate; completed = true })
  const rejected = assert.rejects(result, hasCode('tls_process_failed'))
  await tick(); child.stdout.write(`${JSON.stringify(metadata())}\n`); await tick()
  child.close(1, null); await tick(); assert.equal(activationSignal.aborted, true)
  let closed = false; const closing = manager.close().then(() => { closed = true })
  await tick(); assert.equal(closed, false); assert.equal(completed, false)
  release(); await rejected; await closing; assert.equal(completed, true)
})

test('real native lease excludes competing writers before and after awaited activation work', async context => {
  try { await access(firstPartyExecutable) } catch { context.skip('build the first-party host for native integration'); return }
  const owned = await createSidecarFixtureRoot('native-tls-held')
  const directory = join(owned.directory, 'host')
  const first = new NativeTlsManager({ executable: firstPartyExecutable, dataDirectory: directory })
  const competitor = new NativeTlsManager({ executable: firstPartyExecutable, dataDirectory: directory })
  try {
    const result = await first.withPrepared({}, async (metadata, signal) => {
      assert.equal(signal.aborted, false)
      await assert.rejects(competitor.renew(), hasCode('tls_process_failed'))
      await tick()
      await assert.rejects(competitor.prepare(), hasCode('tls_process_failed'))
      assert.equal(signal.aborted, false)
      return metadata
    })
    const renewed = await first.withRenewed({}, async (metadata, signal) => {
      await assert.rejects(competitor.renew(), hasCode('tls_process_failed'))
      assert.equal(signal.aborted, false); return metadata
    })
    assert.notEqual(result.leafFingerprint256, renewed.leafFingerprint256)
    assert.equal(result.instanceId, renewed.instanceId)
    assert.equal((await competitor.prepare()).leafFingerprint256, renewed.leafFingerprint256)
  } finally { await first.close(); await competitor.close(); await owned.cleanup() }
})

test('aborting a real held activation waits for native close and does not roll back its durable CA', async context => {
  try { await access(firstPartyExecutable) } catch { context.skip('build the first-party host for native integration'); return }
  const owned = await createSidecarFixtureRoot('native-tls-held-abort')
  const directory = join(owned.directory, 'host'), abort = new AbortController()
  let actualClosed = false, started, prepared
  const activationStarted = new Promise(resolve => { started = resolve })
  const first = new NativeTlsManager({ executable: firstPartyExecutable, dataDirectory: directory,
    spawnImpl(file, args, options) { const child = spawn(file, args, options); child.once('close', () => { actualClosed = true }); return child } })
  const second = new NativeTlsManager({ executable: firstPartyExecutable, dataDirectory: directory })
  try {
    const pending = first.withPrepared({ signal: abort.signal }, async (metadata, signal) => {
      prepared = metadata; started()
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled trusted activation')), { once: true }))
    })
    const rejected = assert.rejects(pending, hasCode('tls_operation_cancelled'))
    await activationStarted; assert.equal(actualClosed, false); abort.abort()
    await rejected; assert.equal(actualClosed, true)
    const restored = await second.prepare()
    assert.equal(restored.instanceId, prepared.instanceId); assert.equal(restored.endpointId, prepared.endpointId)
    assert.equal(restored.leafFingerprint256, prepared.leafFingerprint256)
  } finally { await first.close(); await second.close(); await owned.cleanup() }
})
