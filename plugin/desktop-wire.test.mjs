import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { assertLaunchRequest,readLaunchRequest,LAUNCH_PATH } from './security.mjs'

test('official Desktop streamed POST preserves bounded authenticated management admission',async t => {
  let origin,receivedTransferEncoding,receivedContentLength,admitted = 0
  const server = createServer(async (request,response) => {
    receivedTransferEncoding = request.headers['transfer-encoding']; receivedContentLength = request.headers['content-length']
    try {
      assertLaunchRequest(request,origin,{ requestRejection:() => undefined })
      await readLaunchRequest(request)
      admitted++; response.writeHead(200); response.end('accepted')
    } catch { if (!response.destroyed) { response.writeHead(403); response.end('rejected') } }
  })
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  // Desktop forwards Request.body with duplex:half after removing browser Origin.
  const incoming = new Request('http://desktop.invalid'+LAUNCH_PATH,{ method:'POST',headers:{ 'Content-Type':'application/json','X-DSH-Iroh-Admin':'dsh-app://app' },body:'{"version":1}' })
  const response = await fetch(origin+LAUNCH_PATH,{ method:incoming.method,headers:incoming.headers,body:incoming.body,duplex:'half' })
  await response.text()
  assert.equal(receivedTransferEncoding,'chunked')
  assert.equal(receivedContentLength,undefined)
  assert.equal(response.status,200)
  assert.equal(admitted,1)
})

test('streamed Desktop requests retain authentication, size limits and unambiguous HTTP framing',async t => {
  let origin,admitted = 0,bodyRejected = 0,parserRejected = 0
  const server = createServer(async (request,response) => {
    try {
      assertLaunchRequest(request,origin,{ requestRejection:() => request.headers.cookie === 'owned-fixture' ? undefined : 401 })
      try { await readLaunchRequest(request) } catch (error) { bodyRejected++; throw error }
      admitted++; response.writeHead(200); response.end('accepted')
    } catch { if (!response.destroyed) { response.writeHead(403); response.end('rejected') } }
  })
  server.on('clientError',(_error,socket) => { parserRejected++; socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n') })
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const streamed = async (body,headers = {}) => {
    const incoming = new Request('http://desktop.invalid'+LAUNCH_PATH,{ method:'POST',headers:{ 'Content-Type':'application/json','X-DSH-Iroh-Admin':'dsh-app://app',Cookie:'owned-fixture',...headers },body })
    return fetch(origin+LAUNCH_PATH,{ method:'POST',headers:incoming.headers,body:incoming.body,duplex:'half' })
  }
  for (const headers of [{ Cookie:'wrong' },{ Origin:'http://evil.invalid' },{ 'X-DSH-Iroh-Admin':'unknown' }]) {
    const response = await streamed('{"version":1}',headers)
    assert.equal(response.status,403); await response.text()
  }
  assert.equal(admitted,0)
  const oversized = await streamed(' '.repeat(65)).then(async response => ({ status:response.status,text:await response.text() }),error => ({ networkError:error }))
  assert.equal(bodyRejected,1,'the real decoded incoming stream must reach its own 64-byte rejection')
  assert.equal(admitted,0)
  assert.ok(oversized.status >= 400 || oversized.networkError?.cause?.code === 'UND_ERR_SOCKET')
  const raw = extraHeaders => new Promise((resolve,reject) => {
    const socket = createConnection({ host:'127.0.0.1',port:server.address().port })
    let result = ''
    socket.setTimeout(2000,() => socket.destroy(new Error('fixture socket timeout')))
    socket.once('error',reject); socket.on('data',chunk => { result += chunk.toString('utf8') }); socket.once('close',() => resolve(result))
    socket.once('connect',() => socket.write(`POST ${LAUNCH_PATH} HTTP/1.1\r\nHost: ${new URL(origin).host}\r\nContent-Type: application/json\r\nX-DSH-Iroh-Admin: dsh-app://app\r\nCookie: owned-fixture\r\nConnection: close\r\n${extraHeaders}\r\nD\r\n{"version":1}\r\n0\r\n\r\n`))
  })
  assert.match(await raw('Transfer-Encoding: chunked\r\nContent-Length: 13\r\n'),/^HTTP\/1.1 400/u)
  assert.match(await raw('Transfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n'),/^HTTP\/1.1 400/u)
  assert.ok(parserRejected >= 2)
  assert.equal(admitted,0)
})
