import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { createOperatorOwner,OperatorOwnerError } from './operator-owner.mjs'
import { createExtensionHost } from './extension-host.mjs'

const config = { version:1,upstreamOrigin:'http://127.0.0.1:9555',localPort:28443,localOnly:true }
const authorized = { version:1,upstreamAuthenticatedUrl:`${config.upstreamOrigin}/?token=NEVER_PERSIST`,localPort:config.localPort,localOnly:config.localOnly }
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise,resolve } }
function fixture(t,overrides = {}) {
  const events = [],saved = [],sessions = []
  let persisted = null,enabled = false
  const preferenceStore = { load:async () => ({ version:1,enabled }),save:async value => { enabled = value.enabled; return value },close:async () => { events.push('preferences-close') } }
  const configStore = { load:async () => persisted,save:async value => { saved.push(value); persisted = value; return value },close:async () => { events.push('config-close') } }
  const tlsManager = { status:() => ({ state:'ready',leafValidTo:Date.now()+90*86400000,tls:{ keyFile:'SECRET_PATH' } }),close:async () => { events.push('tls-close') } }
  const extensionFactory = async () => { events.push('extensions-create'); return { service:{},close:async () => { events.push('extensions-close') } } }
  const sessionFactory = options => {
    events.push('session-create')
    let state = { enabled:false,state:'off' }
    const session = { options,status:() => state,tlsStatus:tlsManager.status,
      start:async () => { events.push('session-start'); state = { enabled:true,state:'ready',endpointId:'a'.repeat(64) } },
      restore:async () => { events.push('session-restore'); state = { enabled,state:enabled ? 'ready' : 'off' } },
      reconnect:async () => { events.push('session-reconnect'); state = { enabled:true,state:'ready' } },
      close:async () => { events.push('session-close'); state = { ...state,state:'off' } },
      listPeers:async () => [],forgetPeer:async () => [],openPairing:async () => ({ private:'PAIR_SECRET' }),cancelPairing:async () => { events.push('cancel-pairing') },renewTls:async () => {},
    }
    sessions.push(session); return session
  }
  const owner = createOperatorOwner({ mobile:{},modulePath:resolve('fixture/mobile/index.mjs'),executable:resolve('fixture/host.exe'),dataDirectory:resolve('fixture/private'),
    preferenceStore,configStore,tlsManager,extensionFactory,sessionFactory,...overrides })
  t.after(() => owner.close())
  return { owner,events,saved,sessions,preferenceStore,configStore,tlsManager,setPersisted:value => { persisted = value },setEnabled:value => { enabled = value } }
}

test('inert owner restores only non-secret settings and retains the chosen port until authorization is supplied',async t => {
  const f = fixture(t); f.setPersisted(config); f.setEnabled(true)
  assert.deepEqual(f.events,[])
  const state = await f.owner.initialize()
  assert.equal(state.localPort,28443); assert.equal(state.localOnly,true); assert.equal(state.configured,false); assert.equal(state.enabled,true)
  assert.equal(f.sessions.length,0)
  assert.doesNotMatch(JSON.stringify(state),/SECRET_PATH|keyFile|NEVER_PERSIST/u)
  await assert.rejects(f.owner.start(),error => error instanceof OperatorOwnerError && error.code === 'operator_configuration_required')
  assert.equal(f.sessions.length,0)
})

test('configuration persists only canonical Origin and runtime composition passes the in-memory authorized URL',async t => {
  const f = fixture(t)
  await f.owner.configure(authorized)
  assert.deepEqual(f.saved,[config]); assert.doesNotMatch(JSON.stringify(f.saved),/token|NEVER_PERSIST/u)
  await f.owner.start()
  assert.equal(f.sessions[0].options.upstreamAuthenticatedUrl,authorized.upstreamAuthenticatedUrl)
  assert.equal(f.sessions[0].options.tlsManager,f.tlsManager)
  assert.doesNotMatch(JSON.stringify(f.owner.status()),/token|NEVER_PERSIST|SECRET_PATH/u)
  await assert.rejects(f.owner.configure(authorized),{ code:'operator_stop_before_configuring' })
  await f.owner.close()
  assert.deepEqual(f.events.slice(-4),['extensions-close','tls-close','preferences-close','config-close'])
})

test('invalid configuration cannot reach a durable store',async t => {
  const f = fixture(t)
  for (const value of [{ ...authorized,filename:'elsewhere' },{ ...authorized,upstreamAuthenticatedUrl:'http://evil.invalid/?token=secret' },{ ...authorized,upstreamAuthenticatedUrl:'http://localhost/?token=secret' },{ ...authorized,upstreamAuthenticatedUrl:'http://127.0.0.1/' },{ ...authorized,localPort:1 }]) await assert.rejects(f.owner.configure(value),{ code:'invalid_operator_configuration' })
  assert.deepEqual(f.saved,[])
})

test('current Host authorization retains saved port and enable intent but never stores its token',async t => {
  const f = fixture(t); f.setPersisted(config); f.setEnabled(true)
  const state = await f.owner.authorizeCurrentHost('http://127.0.0.1:9666/?token=FRESH_PROCESS_SECRET')
  assert.equal(state.enabled,true); assert.equal(state.configured,true)
  assert.equal(state.localPort,config.localPort); assert.equal(state.localOnly,true)
  assert.equal(f.sessions.length,0)
  assert.deepEqual(f.saved,[{ ...config,upstreamOrigin:'http://127.0.0.1:9666' }])
  assert.doesNotMatch(JSON.stringify(f.saved),/token|FRESH_PROCESS_SECRET/u)
  await f.owner.restore()
  assert.equal(f.sessions[0].options.upstreamAuthenticatedUrl,'http://127.0.0.1:9666/?token=FRESH_PROCESS_SECRET')
})

test('concurrent configuration saves are serialized and an acknowledged chosen port is not silently replaced',async t => {
  const gate = deferred(); let active = 0,maxActive = 0
  const saved = []
  const f = fixture(t,{ configStore:{ load:async () => null,save:async value => { active++; maxActive = Math.max(maxActive,active); saved.push(value); if (saved.length === 1) await gate.promise; active--; return value },close:async () => {} } })
  await f.owner.initialize()
  const first = f.owner.configure(authorized),second = f.owner.configure({ ...authorized,localPort:28444 })
  await tick(); assert.equal(saved.length,1)
  gate.resolve(); await Promise.all([first,second])
  assert.equal(maxActive,1); assert.equal(f.owner.status().localPort,28444)
})

test('stop during a pending extension creation prevents a late Host from being constructed',async t => {
  const gate = deferred(),entered = deferred()
  const f = fixture(t,{ extensionFactory:async () => { entered.resolve(); await gate.promise; return { service:{},close:async () => {} } } })
  await f.owner.configure(authorized)
  const starting = f.owner.start(),rejected = assert.rejects(starting,{ code:'operator_operation_cancelled' })
  await entered.promise
  const stopping = f.owner.stop(); gate.resolve()
  await stopping; await rejected
  assert.equal(f.sessions.length,0); assert.equal(f.owner.status().enabled,false)
})

test('caller cancellation retires pending startup before any successful late result is accepted',async t => {
  const started = deferred(),gate = deferred(),abort = new AbortController()
  let closed = 0
  const f = fixture(t,{ sessionFactory:() => ({ status:() => ({ enabled:true,state:'starting' }),start:async () => { started.resolve(); await gate.promise },close:async () => { closed++ } }) })
  await f.owner.configure(authorized)
  const starting = f.owner.start({ signal:abort.signal }),rejected = assert.rejects(starting,{ code:'operator_operation_cancelled' })
  await started.promise; abort.abort(); await tick(); assert.ok(closed > 0)
  gate.resolve(); await rejected
  assert.notEqual(f.owner.status().state,'ready')
})

test('cancelled read-only polling drains without closing a working phone transport',async t => {
  const f = fixture(t),gate = deferred(),abort = new AbortController()
  await f.owner.configure(authorized); await f.owner.start()
  f.sessions[0].listPeers = () => gate.promise
  const reading = f.owner.listPeers({ signal:abort.signal }),rejected = assert.rejects(reading,{ code:'operator_operation_cancelled' })
  abort.abort(); gate.resolve([]); await rejected
  assert.equal(f.owner.status().state,'ready'); assert.equal(f.events.includes('session-close'),false)
  await f.owner.cancelPairing(); assert.equal(f.events.includes('cancel-pairing'),true)
})

test('failed actual Host close retains dependent owners and supports a later explicit retry',async t => {
  const f = fixture(t)
  await f.owner.configure(authorized); await f.owner.start()
  const original = f.sessions[0].close
  f.sessions[0].close = async () => { throw new Error('NEVER_EXPOSE') }
  await assert.rejects(f.owner.close(),{ code:'operator_cleanup_failed' })
  assert.equal(f.events.includes('tls-close'),false); assert.equal(f.events.includes('extensions-close'),false)
  f.sessions[0].close = original
  await f.owner.close(); assert.equal(f.events.includes('tls-close'),true)
})

test('stop does not claim a cancelled configuration write was rolled back',async t => {
  const writing = deferred(),gate = deferred()
  const f = fixture(t,{ configStore:{ load:async () => null,save:async value => { writing.resolve(); await gate.promise; return value },close:async () => {} } })
  await f.owner.initialize()
  const configuring = f.owner.configure(authorized),rejected = assert.rejects(configuring,{ code:'operator_configuration_outcome_unknown' })
  await writing.promise
  const stopping = f.owner.stop(); gate.resolve()
  await stopping; await rejected
  assert.equal(f.owner.status().configured,false); assert.equal(f.sessions.length,0)
})

test('close drains underlying read work even after its HTTP observer would already have left',async t => {
  const f = fixture(t),gate = deferred()
  await f.owner.configure(authorized); await f.owner.start()
  f.sessions[0].listPeers = () => gate.promise
  const query = f.owner.listPeers(),rejected = assert.rejects(query,{ code:'operator_operation_cancelled' })
  let closed = false
  const closing = f.owner.close().then(() => { closed = true })
  await tick(); assert.equal(closed,false); assert.equal(f.events.includes('tls-close'),false)
  gate.resolve([]); await closing; await rejected
  assert.equal(closed,true)
})

test('a provider failure plus actual extension cleanup failure cannot be reused by a later activation',async t => {
  const entries = new Map(),effects = [],gate = deferred()
  let cleanupAllowed = false,closeCalls = 0,factories = 0,oldDisposed = false
  class Context {
    effect(setup) { effects.push(setup()) }
    fiber = { dispose:async () => { for (const dispose of effects.splice(0).reverse()) await dispose(); oldDisposed = true } }
  }
  const service = { status:() => ({}),registerExtension:definition => { entries.set(definition.id,definition); return () => entries.delete(definition.id) },
    stopLocal:async () => { closeCalls++; if (!cleanupAllowed) throw new Error('fixture cleanup failed'); await gate.promise },
  }
  const f = fixture(t,{ extensionFactory:async () => {
    factories++
    if (factories === 1) return createExtensionHost({ Context,mobile:{ createMobileAccessService:() => service },providers:[({ registerExtension }) => {
      registerExtension({ id:'partial' }); throw new Error('fixture provider failed')
    }] })
    assert.equal(oldDisposed,true); assert.equal(entries.size,0)
    return { service:{},close:async () => {} }
  } })
  await f.owner.configure(authorized)
  await assert.rejects(f.owner.start(),{ code:'operator_start_failed' })
  assert.equal(entries.size,1); assert.equal(closeCalls,1); assert.equal(f.sessions.length,0)
  await assert.rejects(f.owner.start(),{ code:'operator_cleanup_failed' })
  assert.equal(factories,1); assert.equal(f.sessions.length,0)
  cleanupAllowed = true
  const retry = f.owner.start()
  await tick(); assert.equal(factories,1); assert.equal(f.sessions.length,0)
  gate.resolve(); await retry
  assert.equal(factories,2); assert.equal(f.sessions.length,1); assert.equal(f.owner.status().state,'ready')
})
