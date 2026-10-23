import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { createPluginRuntime } from './runtime.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise,resolve } }
function fixture(t,overrides = {},options = {}) {
  const calls = [],saved = [],servers = []
  const owner = { enabled:false,authorizeCurrentHost:async value => { calls.push('authorize'); saved.push(value) },status:() => ({ enabled:owner.enabled,state:'off' }),
    configure:async value => saved.push(value),restore:async () => calls.push('restore'),close:async () => calls.push('owner-close'),
    start:async () => {},stop:async () => {},reconnect:async () => {},openPairing:async () => {},cancelPairing:async () => {},listPeers:async () => [],forgetPeer:async () => [],renewTls:async () => {} }
  let serial = 0
  const runtime = createPluginRuntime({ webServer:{ host:'127.0.0.1',protocol:'http:',port:9555 },connection:{ authenticatedUrl:base => base+'/?token=HOST_SECRET' },dataDirectory:resolve('fixture/owned'),...options },{
    resolveNative:async () => resolve('fixture/native.exe'),loadMobile:async () => ({ mobile:{},modulePath:resolve('fixture/mobile.mjs') }),loadQr:async () => ({ toBuffer:async () => Buffer.from('qr') }),
    ownerFactory:() => owner,serverFactory:async options => { calls.push('server-create'); servers.push(options); return { issueLaunchUrl:() => `http://127.0.0.1:9944/#${++serial}`,close:async () => calls.push('server-close') } },
    openUrl:async url => { calls.push('browser-open'); assert.doesNotMatch(url,/HOST_SECRET/u) },...overrides,
  })
  t.after(() => runtime.close())
  return { runtime,owner,calls,saved,servers }
}
test('plugin initialization authorizes current Host without enabling transport or opening browser',async t => {
  const f = fixture(t)
  await f.runtime.initialize()
  assert.deepEqual(f.calls,['authorize'])
  assert.deepEqual(f.saved,['http://127.0.0.1:9555/?token=HOST_SECRET'])
  f.owner.enabled = true
  await f.runtime.launch()
  assert.deepEqual(f.calls,['authorize','server-create','browser-open'])
  assert.equal(f.servers[0].owner.managedHost,true)
  assert.equal(f.servers[0].owner.status().managedHost,true)
  await f.servers[0].owner.configure({ version:1,localPort:9443,localOnly:false })
  assert.deepEqual(f.saved[1],{ version:1,localPort:9443,localOnly:false,upstreamAuthenticatedUrl:'http://127.0.0.1:9555/?token=HOST_SECRET' })
  await assert.rejects(f.servers[0].owner.configure({ version:1,localPort:9443,localOnly:false,upstreamAuthenticatedUrl:'http://evil.invalid' }),{ code:'iroh_invalid_configuration' })
})
test('persisted enable intent restores and a transport error remains manageable',async t => {
  const f = fixture(t); f.owner.enabled = true
  f.owner.restore = async () => { f.calls.push('restore'); throw new Error('PRIVATE_DETAILS') }
  await f.runtime.initialize(); await f.runtime.launch()
  assert.deepEqual(f.calls,['authorize','restore','server-create','browser-open'])
})
test('concurrent opens cannot duplicate browser effects, and close waits for the helper',async t => {
  const gate = deferred(),entered = deferred()
  const f = fixture(t,{ openUrl:async () => { entered.resolve(); await gate.promise } })
  const opening = f.runtime.launch(),rejected = assert.rejects(opening,{ code:'iroh_operation_cancelled' })
  await entered.promise
  await assert.rejects(f.runtime.launch(),{ code:'iroh_launch_busy' })
  let closed = false
  const closing = f.runtime.close().then(() => { closed = true })
  await tick(); assert.equal(closed,false)
  gate.resolve(); await closing; await rejected
  assert.deepEqual(f.calls.slice(-2),['server-close','owner-close'])
})
test('close during native resolution prevents late owner or server creation',async t => {
  const gate = deferred(),entered = deferred()
  const f = fixture(t,{ resolveNative:async () => { entered.resolve(); return gate.promise } })
  const initializing = f.runtime.initialize(),rejected = assert.rejects(initializing,{ code:'iroh_initialization_failed' })
  await entered.promise
  const closing = f.runtime.close(); gate.resolve(resolve('fixture/native.exe'))
  await closing; await rejected
  assert.deepEqual(f.calls,[])
})
test('failed actual server close retains dependent Host and can be retried',async t => {
  let allow = false
  const f = fixture(t,{ serverFactory:async () => ({ issueLaunchUrl:() => 'local',close:async () => { if (!allow) throw new Error('private') } }) })
  await f.runtime.launch()
  await assert.rejects(f.runtime.close(),{ code:'iroh_cleanup_failed' })
  assert.equal(f.calls.includes('owner-close'),false)
  allow = true; await f.runtime.close(); assert.equal(f.calls.includes('owner-close'),true)
})
test('malformed current Host credentials never construct an owner or escape diagnostics',async t => {
  const f = fixture(t,{}, { connection:{ authenticatedUrl:() => 'http://evil.invalid/?token=PRIVATE' } })
  await assert.rejects(f.runtime.initialize(),{ code:'iroh_initialization_failed' })
  assert.deepEqual(f.calls,[])
})
