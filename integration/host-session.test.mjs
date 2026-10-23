import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { createHostSession, HostOperatorError } from './host-session.mjs'
import { irohOrigin } from './origin-contract.mjs'
import { decodePairingDescriptor } from './pairing-descriptor.mjs'

// Public certificate only, shared in value with the descriptor test fixture.
const CA = 'MIIBZjCCAQygAwIBAgIJIO3VUGW99Y1DMAoGCCqGSM49BAMCMCkxJzAlBgNVBAMTHklyb2ggZGVzY3JpcHRvciBwdWJsaWMgdGVzdCBDQTAeFw0yNjEwMjAxNzAyNDdaFw0yNzEwMjAxNzAyNDdaMCkxJzAlBgNVBAMTHklyb2ggZGVzY3JpcHRvciBwdWJsaWMgdGVzdCBDQTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABDVMJkRvYw3iJUN2X+RiEU8KtDgFyjUTFYTXAYhge0ztH9etj3n5x8JQIwacFPtcYN5IX1onmj5oRGfCNYxT4h2jHTAbMAwGA1UdEwQFMAMBAf8wCwYDVR0PBAQDAgEGMAoGCCqGSM49BAMCA0gAMEUCIDVY/juF8b+H95Qy8XG8SYGzioE/WH/4aFAJ7/0gr8g2AiEA9vQgbCAaBb6pEqfp3g6mAG0m8mNo6dTjIYzbq5APQno='
const now = Date.parse('2026-10-20T17:03:00Z'), endpointId = 'a'.repeat(64), peer = 'b'.repeat(64)
const gatewayToken = Buffer.alloc(32, 42).toString('base64url')
const tick = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

function fixture(overrides = {}) {
  const calls = [], statuses = [], sidecars = [], gateways = [], saved = []
  let stored = { version: 1, enabled: false }
  const store = { load: async () => { calls.push('store-load'); return stored }, save: async (value) => { calls.push(`store-save:${value.enabled}`); stored = value; saved.push(value) } }
  const options = {
    executable: resolve('sidecar.exe'), dataDirectory: resolve('unused-operator-profile'), store,
    commandTimeoutMs: 30, now: () => now,
    onStatus: (status) => statuses.push(status),
    resolveIdentity: async () => { calls.push('identity'); return endpointId },
    gatewayFactory: async ({ endpointId: requested }) => {
      assert.equal(requested, endpointId); calls.push('gateway-create')
      const gateway = { proxyTarget: 'https://127.0.0.1:25443', advertisedOrigin: irohOrigin(endpointId), caCertificate: CA,
        instanceId: createHash('sha256').update(Buffer.from(CA, 'base64')).digest('hex'),
        gateway: { access: { openPairing: async () => { calls.push('mobile-pairing'); return { token: gatewayToken, expiresAt: now + 180000 } } } },
        close: async () => { calls.push('gateway-close') },
      }
      gateways.push(gateway); return gateway
    },
    sidecarFactory: () => {
      const listeners = new Set()
      const sidecar = {
        events: [{ version: 1, type: 'pairing', code: '999999', expires_in_sec: 600 }],
        autoPair: true, autoDevices: true, peers: [{ id: peer, name: 'phone', paired_at: 'unix:1', online: true }],
        onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
        emit: (event) => { for (const listener of [...listeners]) listener(event) },
        start: async () => { calls.push('sidecar-start'); return { endpoint_id: endpointId } },
        stop: async () => { calls.push('sidecar-stop') },
        send: (command) => {
          calls.push(command.type)
          if (command.type === 'pairing-begin' && sidecar.autoPair) queueMicrotask(() => sidecar.emit({ version: 1, type: 'pairing', code: '123456', expires_in_sec: 90 }))
          if (command.type === 'device-forget') sidecar.peers = sidecar.peers.filter((device) => device.id !== command.id)
          if (['device-list', 'device-forget'].includes(command.type) && sidecar.autoDevices) queueMicrotask(() => sidecar.emit({ version: 1, type: 'devices', devices: sidecar.peers }))
        },
      }
      sidecars.push(sidecar); return sidecar
    },
    ...overrides,
  }
  const session = createHostSession(options)
  return { session, options, calls, statuses, sidecars, gateways, saved, store, setStored: (value) => { stored = value } }
}
const hasCode = (code) => (error) => error instanceof HostOperatorError && error.code === code

test('construction is inert; safe identity preparation precedes store access and explicit start', async () => {
  const f = fixture()
  assert.deepEqual(f.calls, [])
  await f.session.start()
  assert.equal(f.calls[0], 'identity'); assert.equal(f.calls[1], 'store-load')
  assert.equal(f.session.status().state, 'ready')
  await f.session.close()
  assert.equal(f.session.status().state, 'off')
  assert.equal(f.saved.at(-1).enabled, true)
})

test('managed TLS and extension owners are forwarded without transferring their lifetime', async () => {
  const tlsManager = { status: () => ({ state: 'unprepared' }), close: () => assert.fail('external TLS owner was closed') }
  const extensionHost = { service: {}, close: () => assert.fail('external extension owner was closed') }
  let gatewayOptions
  const base = fixture()
  const f = fixture({ tlsManager, extensionHost, tlsCheckIntervalMs: 10, tlsRenewBeforeMs: 20,
    gatewayFactory: async options => { gatewayOptions = options; return base.options.gatewayFactory(options) } })
  await f.session.start()
  assert.strictEqual(gatewayOptions.tlsManager, tlsManager)
  assert.strictEqual(gatewayOptions.extensionHost, extensionHost)
  assert.equal(gatewayOptions.tlsCheckIntervalMs, 10)
  assert.equal(gatewayOptions.tlsRenewBeforeMs, 20)
  assert(gatewayOptions.signal instanceof AbortSignal)
  assert.equal(gatewayOptions.signal.aborted, false)
  await f.session.stop()
  assert.equal(gatewayOptions.signal.aborted, true)
  await f.session.close(); await base.session.close()
})

test('explicit reconnect replaces consumers without changing endpoint or enabled preference', async () => {
  const f = fixture()
  await f.session.start()
  const first = f.session.status().endpointId
  await f.session.reconnect()
  assert.equal(f.session.status().endpointId, first)
  assert.equal(f.session.status().state, 'ready')
  assert.equal(f.sidecars.length, 2)
  assert.equal(f.gateways.length, 2)
  assert.equal(f.saved.at(-1).enabled, true)
  await f.session.close()
})

test('failed leaf renewal keeps the working Gateway and transport ready', async () => {
  const f = fixture()
  await f.session.start()
  f.gateways[0].tlsStatus = () => ({ state: 'ready', leafValidTo: now + 1000 })
  f.gateways[0].renewTls = async () => { throw new Error('private-key-path') }
  await assert.rejects(f.session.renewTls(), hasCode('host_operator_tls_renew_failed'))
  assert.equal(f.session.status().state, 'ready')
  assert.equal(f.sidecars.length, 1)
  assert(!f.calls.includes('sidecar-stop'))
  assert.equal(f.session.tlsStatus().leafValidTo, now + 1000)
  f.gateways[0].renewTls = async () => ({ renewed: true })
  assert.deepEqual(await f.session.renewTls(), { renewed: true })
  await f.session.close()
})

test('cancelling a displayed pairing rotates both one-time windows without returning replacements', async () => {
  const f = fixture()
  await f.session.start()
  await f.session.openPairing()
  const before = f.calls.filter(call => call === 'mobile-pairing').length
  const result = await f.session.cancelPairing()
  assert.deepEqual(result, { cancelled: true })
  assert.equal(f.calls.filter(call => call === 'mobile-pairing').length, before + 1)
  assert.equal(f.calls.filter(call => call === 'pairing-begin').length, 2)
  assert(!JSON.stringify(result).includes('123456'))
  assert.equal(f.session.status().state, 'ready')
  await f.session.close()
})

test('restore retains disabled choice and does not create a gateway or save enabled', async () => {
  const f = fixture()
  assert.deepEqual(await f.session.restore(), { enabled: false, state: 'off' })
  assert.deepEqual(f.calls, ['identity', 'store-load'])
  assert.deepEqual(f.saved, [])
  await assert.rejects(f.session.openPairing(), hasCode('host_operator_not_ready'))
  await f.session.close()
})

test('a new Host owner restores true after close and false after durable stop', async () => {
  const first = fixture()
  await first.session.start(); await first.session.close()
  const writes = first.saved.length
  const restored = fixture({ store: first.store })
  assert.equal((await restored.session.restore()).state, 'ready')
  assert.equal(first.saved.length, writes)
  assert.equal(restored.sidecars.length, 1)
  await restored.session.stop(); await restored.session.close()
  assert.deepEqual(first.saved.at(-1), { version: 1, enabled: false })
  const disabled = fixture({ store: first.store })
  const disabledWrites = first.saved.length
  assert.deepEqual(await disabled.session.restore(), { enabled: false, state: 'off' })
  assert.equal(disabled.sidecars.length, 0); assert.equal(first.saved.length, disabledWrites)
  await disabled.session.close()
})

test('queued restore and explicit start preserve the callers distinct intents', async () => {
  const f = fixture()
  const restoring = f.session.restore(), starting = f.session.start()
  assert.strictEqual(f.session.restore(), restoring)
  assert.deepEqual(await restoring, { enabled: false, state: 'off' })
  assert.equal((await starting).state, 'ready')
  assert.equal(f.sidecars.length, 1); assert.equal(f.saved.length, 1)
  await f.session.close()
})

test('corrupt restored preference is never replaced or treated as enabled', async () => {
  const f = fixture(); f.setStored({ version: 2, enabled: true })
  await assert.rejects(f.session.restore(), hasCode('invalid_host_operator_state'))
  assert.equal(f.gateways.length, 0); assert.deepEqual(f.saved, [])
  await f.session.close()
})

test('close cancels a pending preference restore and waits for its owner cleanup', async () => {
  const entered = deferred(), cancelled = deferred(), released = deferred()
  const f = fixture({ store: {
    load: ({ signal }) => {
      entered.resolve()
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { cancelled.resolve(); void released.promise.then(() => reject(new Error('cancelled and closed'))) }, { once: true })
      })
    },
    save: async () => { throw new Error('cancelled restore must not save') },
  } })
  const restoring = f.session.restore(), rejected = assert.rejects(restoring, hasCode('host_operator_cancelled'))
  await entered.promise
  let closed = false
  const closing = f.session.close().then(() => { closed = true })
  await cancelled.promise; await tick(); assert.equal(closed, false)
  released.resolve(); await closing; await rejected
  assert.equal(f.gateways.length, 0)
  await assert.rejects(f.session.restore(), hasCode('host_operator_closed'))
})

test('stop cancels a pending restore before durably recording disabled', async () => {
  const entered = deferred(); let loads = 0, saved
  const f = fixture({ store: {
    load: ({ signal }) => {
      loads += 1
      if (loads > 1) return Promise.resolve({ version: 1, enabled: true })
      entered.resolve()
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    },
    save: async (value) => { saved = value },
  } })
  const restoring = f.session.restore(), rejected = assert.rejects(restoring, hasCode('host_operator_cancelled'))
  await entered.promise; await f.session.stop(); await rejected
  assert.deepEqual(saved, { version: 1, enabled: false }); assert.equal(f.gateways.length, 0)
  await f.session.close()
})

test('save failure does not start a gateway and is never retried automatically', async () => {
  let writes = 0
  const f = fixture({ store: { load: async () => ({ version: 1, enabled: false }), save: async () => { writes += 1; throw new Error('disk unavailable') } } })
  await assert.rejects(f.session.start(), hasCode('host_operator_start_failed'))
  assert.equal(writes, 1); assert.equal(f.gateways.length, 0)
  await f.session.close()
})

test('close aborts a pending enable save before any gateway can be started', async () => {
  const entered = deferred(), cancelled = deferred(), released = deferred()
  const f = fixture({ store: {
    load: async () => ({ version: 1, enabled: false }),
    save: (_state, { signal }) => {
      entered.resolve()
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        cancelled.resolve(); void released.promise.then(() => reject(new Error('save process closed')))
      }, { once: true }))
    },
  } })
  const starting = f.session.start(), rejected = assert.rejects(starting, hasCode('host_operator_cancelled'))
  await entered.promise; const closing = f.session.close(); await cancelled.promise
  released.resolve(); await closing; await rejected; assert.equal(f.gateways.length, 0)
})

test('ordinary object inspection cannot serialize injected launch credentials', async () => {
  const secret = 'http://127.0.0.1:3080/?token=operator-test-launch-secret'
  const f = fixture({ upstreamAuthenticatedUrl: secret })
  assert.equal(JSON.stringify(f.session).includes('operator-test-launch-secret'), false)
  assert.equal('options' in f.session, false)
  await f.session.start()
  assert.equal(JSON.stringify(f.session.status()).includes('token='), false)
  await f.session.close()
})

test('pairing ignores cached startup code and combines only fresh windows with minimum expiry', async () => {
  const f = fixture()
  await f.session.start()
  const qr = await f.session.openPairing()
  assert.equal(qr.descriptor.irohCode, '123456')
  assert.equal(qr.descriptor.expiresAt, now + 90000)
  assert.equal(qr.descriptor.gatewayToken, gatewayToken)
  assert.deepEqual(decodePairingDescriptor(qr.qrPayload, { now }), qr.descriptor)
  assert.ok(f.calls.indexOf('pairing-begin') < f.calls.indexOf('mobile-pairing'))
  for (const status of f.statuses) {
    const encoded = JSON.stringify(status)
    assert.equal(encoded.includes(gatewayToken), false); assert.equal(encoded.includes('123456'), false)
  }
  await f.session.close()
})

test('a startup pairing arriving after Ready cannot satisfy a new pairing request', async () => {
  const f = fixture()
  await f.session.start()
  const sidecar = f.sidecars[0], send = sidecar.send
  sidecar.send = (command) => {
    if (command.type === 'device-list') sidecar.emit({ version: 1, type: 'pairing', code: '999999', expires_in_sec: 600 })
    send(command)
  }
  assert.equal((await f.session.openPairing()).descriptor.irohCode, '123456')
  assert.ok(f.calls.indexOf('device-list') < f.calls.indexOf('pairing-begin'))
  await f.session.close()
})

test('list/forget wait for fresh events and return only safe transport peer fields', async () => {
  const f = fixture()
  await f.session.start()
  assert.equal((await f.session.listPeers())[0].id, peer)
  assert.deepEqual(await f.session.forgetPeer(peer), [])
  await assert.rejects(f.session.forgetPeer('not-an-id'), hasCode('invalid_host_operator_peer'))
  assert.equal(f.calls.filter((value) => value === 'device-forget').length, 1)
  await f.session.close()
})

test('concurrent pairing is rejected, not queued to invalidate the first QR', async () => {
  const f = fixture()
  await f.session.start(); f.sidecars[0].autoPair = false
  const pending = f.session.openPairing()
  await assert.rejects(f.session.openPairing(), hasCode('host_operator_pairing_busy'))
  await tick()
  f.sidecars[0].emit({ version: 1, type: 'pairing', code: '234567', expires_in_sec: 120 })
  assert.equal((await pending).descriptor.irohCode, '234567')
  assert.equal(f.calls.filter((value) => value === 'pairing-begin').length, 1)
  await f.session.close()
})

test('a read-only control timeout preserves the phone data path until explicit reconnect', async () => {
  const f = fixture()
  await f.session.start(); f.sidecars[0].autoDevices = false
  await assert.rejects(f.session.listPeers(), hasCode('host_operator_control_uncertain'))
  assert.equal(f.calls.includes('sidecar-stop'), false)
  assert.equal(f.calls.includes('gateway-close'), false)
  assert.equal(f.session.status().state, 'error')
  assert.equal(f.session.status().errorCode, 'host_operator_control_uncertain')
  f.sidecars[0].emit({ version: 1, type: 'devices', devices: [] })
  await assert.rejects(f.session.forgetPeer(peer), hasCode('host_operator_not_ready'))
  assert.equal(f.calls.includes('device-forget'), false)
  await assert.rejects(f.session.openPairing(), hasCode('host_operator_not_ready'))
  assert.equal(f.calls.includes('sidecar-stop'), false)
  assert.equal(f.calls.includes('gateway-close'), false)
  await f.session.reconnect()
  assert.equal(f.session.status().state, 'ready')
  assert.equal(f.sidecars.length, 2)
  assert.equal((await f.session.listPeers())[0].id, peer)
  await f.session.close()
})

test('a command timeout closes both authorization windows and is never replayed automatically', async () => {
  const f = fixture()
  await f.session.start(); f.sidecars[0].autoPair = false
  await assert.rejects(f.session.openPairing(), hasCode('host_operator_command_timeout'))
  assert.equal(f.calls.includes('mobile-pairing'), false)
  assert.equal(f.calls.filter((value) => value === 'pairing-begin').length, 1)
  assert.ok(f.calls.includes('sidecar-stop')); assert.ok(f.calls.includes('gateway-close'))
  f.sidecars[0].emit({ version: 1, type: 'pairing', code: '999999', expires_in_sec: 600 })
  assert.equal(f.session.status().state, 'error')
  await f.session.start()
  assert.equal(f.sidecars.length, 2)
  assert.equal((await f.session.openPairing()).descriptor.irohCode, '123456')
  await f.session.close()
})

test('stop immediately cancels a pending pairing and remains restartable without losing records', async () => {
  const f = fixture()
  await f.session.start(); f.sidecars[0].autoPair = false
  const pending = f.session.openPairing()
  const rejected = assert.rejects(pending, hasCode('host_operator_cancelled'))
  await tick(); await f.session.stop(); await rejected
  assert.deepEqual(f.session.status(), { enabled: false, state: 'off' })
  assert.equal(f.saved.at(-1).enabled, false)
  f.sidecars[0].emit({ version: 1, type: 'pairing', code: '999999', expires_in_sec: 600 })
  await f.session.start()
  assert.equal(f.session.status().state, 'ready')
  assert.equal(f.calls.filter((value) => value === 'identity').length, 2)
  await f.session.close()
})

test('close invalidates a late Mobile pairing result and never returns its secret', async () => {
  const f = fixture(), mobile = deferred(), entered = deferred()
  await f.session.start()
  f.gateways[0].gateway.access.openPairing = async () => { entered.resolve(); return mobile.promise }
  const pending = f.session.openPairing()
  const rejected = assert.rejects(pending, hasCode('host_operator_cancelled'))
  await entered.promise
  await f.session.close(); await rejected
  mobile.resolve({ token: gatewayToken, expiresAt: now + 60000 }); await tick()
  assert.equal(f.session.status().state, 'off')
  await assert.rejects(f.session.start(), hasCode('host_operator_closed'))
})

test('close during identity preparation cannot start the gateway afterwards', async () => {
  const identity = deferred(), entered = deferred()
  const f = fixture({ resolveIdentity: async () => { entered.resolve(); return identity.promise } })
  const starting = f.session.start()
  const rejected = assert.rejects(starting, hasCode('host_operator_cancelled'))
  await entered.promise
  const close = f.session.close()
  identity.resolve(endpointId)
  await close; await rejected
  assert.equal(f.calls.includes('gateway-create'), false)
})

test('corrupt preference state is not rewritten, and stop still closes active resources', async () => {
  const f = fixture()
  await f.session.start()
  const saves = f.saved.length
  f.setStored({ version: 1, enabled: 'yes' })
  await assert.rejects(f.session.stop(), hasCode('host_operator_stop_failed'))
  assert.equal(f.saved.length, saves)
  assert.ok(f.calls.includes('sidecar-stop')); assert.ok(f.calls.includes('gateway-close'))
  await f.session.close()
})

test('malformed/expired pairing material closes resources and errors do not expose secrets', async () => {
  const f = fixture()
  await f.session.start()
  f.gateways[0].gateway.access.openPairing = async () => ({ token: `${gatewayToken}bad`, expiresAt: now + 60000 })
  await assert.rejects(f.session.openPairing(), (error) => hasCode('host_operator_pairing_failed')(error) && !error.message.includes(gatewayToken))
  assert.ok(f.calls.includes('gateway-close'))
  await f.session.close()
})

test('async display observers cannot own lifecycle or cause unhandled rejections', async () => {
  const f = fixture({ onStatus: async () => { throw new Error('display failed') } })
  await f.session.start(); await f.session.openPairing(); await f.session.close(); await tick()
})

test('failed cleanup is visible as error, retains ownership, and terminal close can retry', async () => {
  const f = fixture()
  await f.session.start()
  f.sidecars[0].stop = async () => { throw new Error('still running') }
  await assert.rejects(f.session.close(), hasCode('host_operator_cleanup_failed'))
  assert.equal(f.session.status().state, 'error')
  assert.equal(f.calls.includes('gateway-close'), false)
  f.sidecars[0].stop = async () => { f.calls.push('sidecar-stop') }
  await f.session.close()
  assert.equal(f.session.status().state, 'off')
  assert.equal(f.calls.includes('gateway-close'), true)
})
