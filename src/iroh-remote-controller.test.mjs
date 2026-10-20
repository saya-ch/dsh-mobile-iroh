import test from 'node:test'
import assert from 'node:assert/strict'
import { IrohRemoteController } from './iroh-remote-controller.mjs'

const id = 'a'.repeat(64)
const advertisedOrigin = `https://${id.slice(0, 32)}.${id.slice(32)}.iroh.localhost:25443`
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise((resolve) => setImmediate(resolve))
function fixture(overrides = {}) {
  const calls = [], listeners = new Set(), saved = []
  const gateway = { proxyTarget: 'https://127.0.0.1:3443', advertisedOrigin, close: async () => { calls.push('gateway-close') } }
  const sidecar = {
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    start: async () => { calls.push('sidecar-start'); return { endpoint_id: id } },
    stop: async () => { calls.push('sidecar-stop') },
  }
  const options = {
    store: { load: async () => ({ version: 1, enabled: false }), save: async (state) => { calls.push('save'); saved.push(state) } },
    resolveEndpointId: async () => id,
    createGateway: async ({ endpointId }) => { assert.equal(endpointId, id); calls.push('gateway-create'); return gateway },
    createSidecar: async ({ proxyTarget }) => { assert.equal(proxyTarget, gateway.proxyTarget); calls.push('sidecar-create'); return sidecar },
    ...overrides,
  }
  return { controller: new IrohRemoteController(options), options, calls, listeners, saved, gateway, sidecar }
}

test('provider preserves disabled startup and initializes only once', async () => {
  const f = fixture()
  await f.controller.initialize(); await f.controller.initialize()
  assert.deepEqual(f.controller.status(), { enabled: false, state: 'off' })
  assert.deepEqual(f.calls, [])
  await f.controller.close()
})

test('enable persists, creates identity-bound TLS gateway, and stops consumer before gateway', async () => {
  const f = fixture()
  await f.controller.initialize(); await f.controller.setEnabled(true)
  assert.equal(f.controller.gateway(), f.gateway)
  assert.deepEqual(f.controller.status(), { enabled: true, state: 'ready', origin: advertisedOrigin, backendOrigin: f.gateway.proxyTarget, endpointId: id })
  await f.controller.setEnabled(false)
  assert.deepEqual(f.calls, ['save', 'gateway-create', 'sidecar-create', 'sidecar-start', 'sidecar-stop', 'gateway-close', 'save'])
  assert.equal(f.controller.gateway(), undefined)
  await f.controller.close()
})

test('durable switch failure creates no gateway', async () => {
  const f = fixture({ store: { load: async () => ({ version: 1, enabled: false }), save: async () => { throw new Error('disk failure') } } })
  await f.controller.initialize()
  await assert.rejects(f.controller.setEnabled(true), /disk failure/)
  assert.equal(f.calls.includes('gateway-create'), false)
  assert.equal(f.controller.status().enabled, false)
  assert.equal(f.controller.status().state, 'error')
  await f.controller.close()
})

test('failed readiness closes both resources and permits explicit reconnect', async () => {
  const f = fixture()
  f.sidecar.start = async () => { throw new Error('ready failed') }
  await f.controller.initialize()
  await assert.rejects(f.controller.setEnabled(true), /ready failed/)
  assert.equal(f.controller.status().errorCode, 'iroh_start_failed')
  assert.deepEqual(f.calls.slice(-2), ['sidecar-stop', 'gateway-close'])
  f.sidecar.start = async () => ({ endpoint_id: id })
  await f.controller.reconnect()
  assert.equal(f.controller.status().state, 'ready')
  await f.controller.close()
})

test('close invalidates late gateway creation and never starts its sidecar', async () => {
  const waiting = defer(), entered = defer()
  const f = fixture({ createGateway: async () => { entered.resolve(); return waiting.promise } })
  await f.controller.initialize()
  const enabling = f.controller.setEnabled(true)
  await entered.promise
  const closed = f.controller.close()
  waiting.resolve(f.gateway)
  await enabling; await closed
  assert.equal(f.calls.includes('sidecar-start'), false)
  assert.equal(f.calls.filter((call) => call === 'gateway-close').length, 1)
  assert.equal(f.controller.status().state, 'off')
})

test('late sidecar ready during close is discarded, not republished as ready', async () => {
  const ready = defer(), entered = defer(), statuses = []
  const f = fixture({ onStatus: (status) => statuses.push(status.state) })
  f.sidecar.start = async () => { entered.resolve(); return ready.promise }
  await f.controller.initialize()
  const enabling = f.controller.setEnabled(true)
  await entered.promise
  const close = f.controller.close()
  ready.resolve({ endpoint_id: id })
  await enabling; await close
  assert.equal(statuses.includes('ready'), false)
  assert.deepEqual(f.calls.slice(-2), ['sidecar-stop', 'gateway-close'])
})

test('sidecar cleanup failure retains gateway ownership and close can retry', async () => {
  const f = fixture()
  await f.controller.initialize(); await f.controller.setEnabled(true)
  f.sidecar.stop = async () => { f.calls.push('failed-stop'); throw new Error('cannot stop') }
  await assert.rejects(f.controller.close(), /cannot stop/)
  assert.equal(f.controller.gateway(), f.gateway)
  assert.equal(f.calls.includes('gateway-close'), false)
  f.sidecar.stop = async () => { f.calls.push('sidecar-stop') }
  await f.controller.close()
  assert.equal(f.controller.gateway(), undefined)
})

test('a gateway close failure remains owned for a retry', async () => {
  const f = fixture()
  await f.controller.initialize(); await f.controller.setEnabled(true)
  f.gateway.close = async () => { throw new Error('gateway busy') }
  await assert.rejects(f.controller.close(), /gateway busy/)
  assert.equal(f.controller.gateway(), f.gateway)
  f.gateway.close = async () => {}
  await f.controller.close()
  assert.equal(f.controller.gateway(), undefined)
})

test('unexpected exit reports error and queues cleanup without silent restart', async () => {
  const f = fixture()
  await f.controller.initialize(); await f.controller.setEnabled(true)
  for (const listener of f.listeners) listener({ type: 'sidecar-exit', code: 1 })
  await tick()
  assert.equal(f.controller.status().state, 'error')
  assert.equal(f.controller.gateway(), undefined)
  assert.equal(f.calls.filter((call) => call === 'sidecar-start').length, 1)
  await f.controller.close()
})

test('identity changes or an unrelated logical hostname fail closed', async () => {
  for (const mismatch of ['ready', 'origin', 'port']) {
    const f = fixture()
    if (mismatch === 'ready') f.sidecar.start = async () => ({ endpoint_id: 'b'.repeat(64) })
    else if (mismatch === 'origin') f.gateway.advertisedOrigin = 'https://foreign.example:25443'
    else f.gateway.advertisedOrigin = advertisedOrigin.replace('25443', '25444')
    await f.controller.initialize()
    await assert.rejects(f.controller.setEnabled(true), /identity changed|does not match/)
    assert.equal(f.controller.gateway(), undefined)
    await f.controller.close()
  }
})

test('corrupt durable state is not replaced with disabled defaults', async () => {
  const f = fixture({ store: { load: async () => ({ enabled: 'true' }), save: async () => { throw new Error('must not rewrite') } } })
  await assert.rejects(f.controller.initialize(), /invalid iroh provider state/)
  assert.deepEqual(f.calls, [])
  await f.controller.close()
})

test('rejected async status observers cannot turn lifecycle success into unhandled rejection', async () => {
  const f = fixture({ onStatus: async () => { throw new Error('observer failed') } })
  await f.controller.initialize(); await f.controller.setEnabled(true); await tick()
  assert.equal(f.controller.status().state, 'ready')
  await f.controller.close(); await tick()
})
