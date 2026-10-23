import test from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { createOperatorServer } from './server.mjs'

const ID = 'a'.repeat(64)
const PEER = { id: 'b'.repeat(64), name: '<script>phone</script>', online: true, paired_at: 'unix:1780000000' }
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64')
function rawCall(origin,headers) {
  return new Promise((resolve,reject) => {
    const request = httpRequest(new URL('/api/v1/status',origin),{ method:'POST',headers },(response) => { response.resume(); response.once('end',() => resolve(response)) })
    request.once('error',reject); request.end('{"version":1}')
  })
}
function mockOwner(overrides = {}) {
  let state = { enabled:false, state:'off', configured:false, localPort:9443, localOnly:false, tls:{ state:'valid', notAfter:Date.now()+86400000, renewable:true } }
  return {
    status:() => ({ ...state, upstreamAuthenticatedUrl:'NEVER_LEAK', privateKey:'NEVER_LEAK' }),
    configure:async (config) => { state = { ...state, configured:true, localPort:config.localPort }; return state },
    start:async () => { state = { ...state, enabled:true, state:'ready', endpointId:ID }; return state },
    stop:async () => { state = { ...state, enabled:false, state:'off' }; return state },
    reconnect:async () => { state = { ...state, enabled:true, state:'ready', endpointId:ID }; return state },
    openPairing:async () => ({ descriptor:{ expiresAt:Date.now()+3000 }, qrPayload:'PRIVATE_PAIRING_SECRET' }),
    listPeers:async () => [PEER], forgetPeer:async () => [], renewTls:async () => state,
    ...overrides,
  }
}
async function fixture(t, options = {}) {
  const server = await createOperatorServer({ owner:mockOwner(), renderQr:async () => PNG, ...options })
  t.after(() => server.close())
  let cookie
  let csrf
  const call = async (route, body = { version:1 }, options = {}) => {
    const response = await fetch(`${server.origin}${route.startsWith('/') ? route : `/api/v1/${route}`}`, {
      method:'POST', headers:{ Origin:server.origin, 'Content-Type':'application/json', ...(cookie ? { Cookie:cookie } : {}), ...(csrf ? { 'X-Operator-CSRF':csrf } : {}), ...options.headers },
      body:typeof body === 'string' ? body : JSON.stringify(body), ...options,
    })
    const text = await response.text()
    return { response, text, body:JSON.parse(text) }
  }
  const login = async () => {
    const result = await call('session', { version:1, token:new URL(server.launchUrl).hash.slice(1) })
    assert.equal(result.response.status,200)
    cookie = result.response.headers.get('set-cookie').split(';')[0]; csrf = result.body.csrf
    return result
  }
  return { server,call,login,get cookie(){ return cookie },get csrf(){ return csrf } }
}

test('operator launch is loopback-only, fragment-only, one-time and short-lived', async (t) => {
  let now = Date.now()
  const f = await fixture(t, { now:() => now, launchLifetimeMs:1000, sessionLifetimeMs:2000 })
  assert.match(f.server.origin,/^http:\/\/127\.0\.0\.1:\d+$/u)
  assert.equal(new URL(f.server.launchUrl).search,'')
  assert.match(new URL(f.server.launchUrl).hash,/^#[A-Za-z0-9_-]{43}$/u)
  const unauthorized = await f.call('status')
  assert.equal(unauthorized.response.status,401); assert.doesNotMatch(unauthorized.text,/NEVER_LEAK/u)
  const login = await f.login()
  const setCookie = login.response.headers.get('set-cookie')
  assert.match(setCookie,/HttpOnly/u); assert.match(setCookie,/SameSite=Strict/u)
  assert.equal((await f.call('session',{ version:1, token:new URL(f.server.launchUrl).hash.slice(1) })).response.status,401)
  const status = await f.call('status')
  assert.equal(status.response.status,200); assert.doesNotMatch(status.text,/NEVER_LEAK|PRIVATE_PAIRING_SECRET|privateKey/u)
  now += 2001
  assert.equal((await f.call('status')).response.status,401)
})

test('operator denies expired launches, alternate hosts, cross origins, missing CSRF, CORS and route escapes', async (t) => {
  let now = Date.now()
  const f = await fixture(t,{ now:() => now,launchLifetimeMs:100 })
  await f.login()
  for (const headers of [{ Host:'localhost:80' }, { Origin:'http://evil.invalid' }, { Origin:'null' }, { 'X-Operator-CSRF':'wrong' }, { 'Sec-Fetch-Site':'cross-site' }]) {
    const response = await rawCall(f.server.origin,{ Origin:f.server.origin,'Content-Type':'application/json',Cookie:f.cookie,'X-Operator-CSRF':f.csrf,'Content-Length':13,...headers })
    assert.equal(response.statusCode,403,JSON.stringify(headers))
    assert.equal(response.headers['access-control-allow-origin'],undefined)
  }
  for (const path of ['/api/v1/status?token=secret','/api/v2/status','/../SECURITY.md','/%2e%2e/SECURITY.md']) {
    assert.equal((await fetch(`${f.server.origin}${path}`,{ headers:{ Origin:f.server.origin } })).status,404)
  }
  const preflight = await fetch(`${f.server.origin}/api/v1/start`,{ method:'OPTIONS',headers:{ Origin:f.server.origin,'Access-Control-Request-Method':'POST' } })
  assert.equal(preflight.status,403)
  assert.equal((await fetch(`${f.server.origin}/api/v1/status`)).status,405)
  now += 101
  const g = await fixture(t,{ now:() => now,launchLifetimeMs:100 })
  now += 101
  assert.equal((await g.call('session',{ version:1,token:new URL(g.server.launchUrl).hash.slice(1) })).response.status,401)
})

test('strict version, fields, JSON, lengths and upstream socket checks precede owner calls', async (t) => {
  let calls = 0
  const f = await fixture(t,{ owner:mockOwner({ configure:async () => { calls++ } }) })
  await f.login()
  for (const value of [{ version:2 },{ version:1,unknown:true },[],null,'{"version":1,"version":1}','{"version":1,}','{"version":1,"extra":"'+ 'x'.repeat(13000)+'"}']) {
    const result = await f.call('start',value)
    assert.ok([400,413].includes(result.response.status),String(result.response.status))
  }
  const configuration = { version:1,upstreamAuthenticatedUrl:'http://127.0.0.1:9555/?token=secret',localPort:9443,localOnly:false }
  for (const url of ['http://evil.invalid/?token=x','http://localhost:9555/?token=x','http://127.0.0.1:9555/','file:///tmp/?token=x','http://user:pass@127.0.0.1/?token=x','http://127.0.0.1/?token=x#secret']) {
    assert.equal((await f.call('configure',{ ...configuration,upstreamAuthenticatedUrl:url })).response.status,400)
  }
  assert.equal((await f.call('configure',{ ...configuration,localPort:1 })).response.status,400)
  assert.equal(calls,0)
})

test('QR image is explicit, pairing material requires authenticated copy, expiry withdraws it', async (t) => {
  let now = Date.now()
  let cancelled = 0
  const f = await fixture(t,{ now:() => now, owner:mockOwner({ openPairing:async () => ({ descriptor:{ expiresAt:now+1000 },qrPayload:'PRIVATE_PAIRING_SECRET' }),cancelPairing:async () => { cancelled++ } }) })
  await f.login()
  const result = await f.call('pairing')
  assert.equal(result.response.status,200); assert.match(result.body.qrImage,/^data:image\/png;base64,/u)
  assert.doesNotMatch(result.text,/PRIVATE_PAIRING_SECRET/u)
  assert.equal((await f.call('pairing/copy')).body.payload,'PRIVATE_PAIRING_SECRET')
  now += 1001
  assert.equal((await f.call('pairing/copy')).response.status,410)
  await f.call('pairing/cancel'); assert.equal(cancelled,1)
})

test('owner errors, even HTTP-like errors, do not echo secrets', async (t) => {
  const f = await fixture(t,{ owner:mockOwner({ start:async () => { throw Object.assign(new Error('PRIVATE_TOKEN'),{ status:400,code:'PRIVATE_TOKEN' }) } }) })
  await f.login()
  const result = await f.call('start')
  assert.equal(result.response.status,502); assert.doesNotMatch(result.text,/PRIVATE_TOKEN/u)
  assert.equal(result.body.error,'operator_operation_failed')
})

test('stop cancels pending pairing and late result cannot restore its QR', async (t) => {
  let release
  let aborted = false
  const f = await fixture(t,{ owner:mockOwner({ openPairing:({ signal }) => new Promise((resolve) => { release = resolve; signal.addEventListener('abort',() => { aborted = true },{ once:true }) }),cancelPairing:async () => {} }) })
  await f.login()
  const pending = f.call('pairing')
  while (!release) await new Promise((resolve) => setTimeout(resolve,1))
  assert.equal((await f.call('stop')).response.status,200)
  assert.equal(aborted,true)
  release({ descriptor:{ expiresAt:Date.now()+10000 },qrPayload:'LATE_SECRET' })
  assert.equal((await pending).response.status,409)
  assert.equal((await f.call('pairing/copy')).response.status,410)
})

test('HTTP disconnect aborts its owner request; server close is idempotent and aborts pending work', async (t) => {
  let observed
  let started
  const ready = new Promise((resolve) => { started = resolve })
  const f = await fixture(t,{ owner:mockOwner({ start:({ signal }) => { observed = signal; started(); return new Promise(() => {}) } }), operationTimeoutMs:1000 })
  await f.login()
  const url = new URL('/api/v1/start',f.server.origin)
  const request = httpRequest(url,{ method:'POST',headers:{ Origin:f.server.origin,'Content-Type':'application/json',Cookie:f.cookie,'X-Operator-CSRF':f.csrf } })
  request.on('error',() => {})
  request.end('{"version":1}')
  await ready; request.destroy()
  while (!observed.aborted) await new Promise((resolve) => setTimeout(resolve,1))
  await f.server.close(); await f.server.close()
  await assert.rejects(fetch(f.server.origin))
})

test('operation deadline is bounded without silently replaying the action', async (t) => {
  let calls = 0
  let signal
  const f = await fixture(t,{ operationTimeoutMs:100,owner:mockOwner({ start:(options) => { calls++; signal = options.signal; return new Promise(() => {}) } }) })
  await f.login()
  const result = await f.call('start')
  assert.equal(result.response.status,409); assert.equal(signal.aborted,true); assert.equal(calls,1)
})

test('session expiry during owner work cannot release newly generated pairing material', async (t) => {
  let now = Date.now()
  let release
  const f = await fixture(t,{ now:() => now,sessionLifetimeMs:100,owner:mockOwner({ openPairing:() => new Promise((resolve) => { release = resolve }) }) })
  await f.login()
  const pending = f.call('pairing')
  const deadline = Date.now()+1000
  while (!release && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve,1))
  assert.equal(typeof release,'function')
  now += 101
  release({ descriptor:{ expiresAt:now+1000 },qrPayload:'DO_NOT_RELEASE' })
  const result = await pending
  assert.equal(result.response.status,401)
  assert.doesNotMatch(result.text,/DO_NOT_RELEASE|data:image/u)
})

test('a failed pairing rotation cannot prevent priority stop containment', async (t) => {
  let stopped = false
  let cleanupFails = true
  const f = await fixture(t,{ owner:mockOwner({ cancelPairing:async () => { if (cleanupFails) throw new Error('PRIVATE') },stop:async () => { stopped = true } }) })
  await f.login()
  const result = await f.call('stop')
  assert.equal(result.response.status,200); assert.equal(stopped,true)
  await assert.rejects(f.server.close())
  cleanupFails = false
  await f.server.close()
})

test('peer projection is bounded and static UI responses have no active external dependencies', async (t) => {
  const f = await fixture(t)
  await f.login()
  const peers = await f.call('peers'); assert.deepEqual(peers.body.peers,[PEER])
  const page = await fetch(f.server.origin)
  assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/u)
  assert.equal(page.headers.get('cache-control'),'no-store')
  assert.equal(page.headers.get('referrer-policy'),'no-referrer')
  assert.doesNotMatch(await page.text(),/https:\/\/|PRIVATE_PAIRING_SECRET|NEVER_LEAK/u)
})

test('the full native 64-scalar peer name survives projection and exact-id forget lookup',async t => {
  const name = '📱'.repeat(64),peer = { ...PEER,name }
  let forgotten
  const f = await fixture(t,{ owner:mockOwner({ listPeers:async () => [peer],forgetPeer:async id => { forgotten = id; return [] } }) })
  await f.login()
  const listed = await f.call('peers')
  assert.equal(listed.response.status,200); assert.equal(listed.body.peers[0].name,name)
  const removed = await f.call('peers/forget',{ version:1,id:peer.id })
  assert.equal(removed.response.status,200); assert.equal(forgotten,peer.id)
  const overlong = await fixture(t,{ owner:mockOwner({ listPeers:async () => [{ ...peer,name:'📱'.repeat(65) }] }) })
  await overlong.login()
  assert.equal((await overlong.call('peers')).response.status,502)
})
