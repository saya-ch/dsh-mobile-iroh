import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { assertLaunchRequest,currentHostOrigin,readLaunchRequest,LAUNCH_PATH } from './security.mjs'

const origin = 'http://127.0.0.1:9555'
const accepted = { requestRejection:() => undefined }
function request(overrides = {}) {
  return { method:'POST',url:LAUNCH_PATH,socket:{ remoteAddress:'127.0.0.1' },rawHeaders:[],
    headers:{ host:'127.0.0.1:9555',origin,'content-type':'application/json','sec-fetch-site':'same-origin','x-dsh-iroh-admin':'same-origin-json' },...overrides }
}
test('upstream identity uses only the current authenticated loopback HTTP listener',() => {
  assert.equal(currentHostOrigin({ host:'127.0.0.1',protocol:'http:',port:9555 }),origin)
  assert.equal(currentHostOrigin({ host:'::1',protocol:'http:',port:9555 }),'http://[::1]:9555')
  for (const change of [{ host:'0.0.0.0' },{ host:'192.168.0.2' },{ host:'localhost' },{ port:undefined },{ port:0 },{ protocol:'https:' }]) {
    assert.throws(() => currentHostOrigin({ host:'127.0.0.1',protocol:'http:',port:9555,...change }),{ code:'iroh_loopback_http_host_required' })
  }
})
test('local Web and authenticated Desktop actions are accepted without trusting loopback alone',() => {
  assert.doesNotThrow(() => assertLaunchRequest(request(),origin,accepted))
  const localhost = request(); localhost.headers.host = 'localhost:9555'; localhost.headers.origin = 'http://localhost:9555'
  assert.doesNotThrow(() => assertLaunchRequest(localhost,origin,accepted))
  const desktop = request(); delete desktop.headers.origin; delete desktop.headers['sec-fetch-site']; desktop.headers['x-dsh-iroh-admin'] = 'dsh-app://app'
  assert.doesNotThrow(() => assertLaunchRequest(desktop,origin,accepted))
  for (const connection of [undefined,{ requestRejection:() => 401 },{ requestRejection:() => 403 }]) {
    assert.throws(() => assertLaunchRequest(desktop,origin,connection),{ code:'iroh_admin_rejected' })
  }
})
test('cross origin, hostile authority, non-loopback, duplicate headers and simple forms fail before effects',() => {
  for (const patch of [{ method:'GET' },{ method:'OPTIONS' },{ url:LAUNCH_PATH+'?token=x' },{ socket:{ remoteAddress:'192.168.0.3' } },{ rawHeaders:['Host','a','Host','b'] }]) {
    assert.throws(() => assertLaunchRequest(request(patch),origin,accepted),{ code:'iroh_admin_rejected' })
  }
  for (const patch of [{ origin:'http://evil.invalid' },{ host:'localhost:9555' },{ host:'localhost:9556' },{ host:'user:secret@127.0.0.1:9555' },{ 'sec-fetch-site':'cross-site' },{ 'content-type':'text/plain' },{ 'content-encoding':'gzip' },{ 'transfer-encoding':'chunked' },{ 'x-dsh-iroh-admin':undefined },{ 'x-dsh-iroh-admin':'dsh-app://app' }]) {
    const candidate = request(); Object.assign(candidate.headers,patch)
    assert.throws(() => assertLaunchRequest(candidate,origin,accepted),{ code:'iroh_admin_rejected' })
  }
})
test('launch body is bounded, versioned, duplicate-key rejecting and cancellable',async () => {
  for (const body of ['{"version":1}',' { "version" : 1 } ']) {
    const stream = Readable.from([Buffer.from(body)]); stream.headers = {}
    await readLaunchRequest(stream)
  }
  for (const body of ['{"version":2}','{"version":1,"version":1}','{"version":1,"url":"x"}','null',' '.repeat(65),'{}']) {
    const stream = Readable.from([Buffer.from(body)]); stream.headers = {}
    await assert.rejects(readLaunchRequest(stream),{ code:'iroh_invalid_request' })
  }
  const stream = Readable.from([Buffer.from('{"version":1}')]); stream.headers = { 'content-length':'500' }
  await assert.rejects(readLaunchRequest(stream),{ code:'iroh_invalid_request' })
  const abort = new AbortController(); abort.abort()
  await assert.rejects(readLaunchRequest(stream,{ signal:abort.signal }))
})
