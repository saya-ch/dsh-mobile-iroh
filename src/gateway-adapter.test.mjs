import test from 'node:test'
import assert from 'node:assert/strict'
import { createGatewayAdapter } from './gateway-adapter.mjs'

test('forwards authenticated request fields to an explicit loopback gateway', async () => {
  let request
  const adapter = createGatewayAdapter({
    target: 'http://127.0.0.1:17380',
    fetchImpl: async (url, init) => {
      request = { url: String(url), init }
      return new Response('gateway-ok', { status: 200, headers: { 'content-type': 'text/plain' } })
    },
  })
  const result = await adapter.forwardHttp({ path: '/mobile-access/health', headers: {
    cookie: 'dsh_session=session', origin: 'http://127.0.0.1:1234', connection: 'upgrade', host: 'attacker.invalid',
  } })
  assert.equal(request.url, 'http://127.0.0.1:17380/mobile-access/health')
  assert.equal(request.init.headers.cookie, 'dsh_session=session')
  assert.equal(request.init.headers.origin, 'http://127.0.0.1:1234')
  assert.equal(request.init.headers.connection, undefined)
  assert.equal(request.init.headers.host, undefined)
  assert.equal(result.status, 200)
  assert.equal(new TextDecoder().decode(result.body), 'gateway-ok')
})

test('rejects non-loopback or path-bearing gateway targets', () => {
  assert.throws(() => createGatewayAdapter({ target: 'http://example.com' }), /explicit loopback/)
  assert.throws(() => createGatewayAdapter({ target: 'http://localhost:1234' }), /explicit loopback/)
  assert.throws(() => createGatewayAdapter({ target: 'http://127.0.0.1:1234/base' }), /must be an origin/)
})

test('rejects absolute, traversal, and oversized requests', async () => {
  const adapter = createGatewayAdapter({ target: 'http://127.0.0.1:1', maxRequestBytes: 3 })
  await assert.rejects(() => adapter.forwardHttp({ path: 'http://example.com/' }), /invalid gateway path/)
  await assert.rejects(() => adapter.forwardHttp({ path: '//example.com/' }), /invalid gateway path/)
  await assert.rejects(() => adapter.forwardHttp({ path: '/', method: 'get' }), /invalid gateway method/)
  await assert.rejects(() => adapter.forwardHttp({ path: '/', body: '1234' }), /request too large/)
})

test('maps websocket scheme without weakening target validation', () => {
  const adapter = createGatewayAdapter({ target: 'https://[::1]:8443' })
  assert.equal(adapter.websocketUrl('/api/stream'), 'wss://[::1]:8443/api/stream')
})

test('streamed responses are cancelled when the byte budget is exceeded', async () => {
  let cancelled = false
  const adapter = createGatewayAdapter({ target: 'http://127.0.0.1:1', maxResponseBytes: 4, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.enqueue(new Uint8Array([4, 5])) },
    cancel() { cancelled = true },
  })) })
  await assert.rejects(adapter.forwardHttp({ path: '/' }), /response too large/)
  assert.equal(cancelled, true)
})

test('multi-cookie responses and request authentication retain separate values', async () => {
  let captured
  const headers = new Headers({ connection: 'x-private', 'x-private': 'no' })
  headers.append('set-cookie', 'session=one; Path=/; HttpOnly')
  headers.append('set-cookie', 'csrf=two; Path=/; SameSite=Strict')
  const adapter = createGatewayAdapter({ target: 'http://127.0.0.1:1', fetchImpl: async (_url, init) => {
    captured = init.headers
    return new Response('ok', { headers })
  } })
  const result = await adapter.forwardHttp({ path: '/', headers: { Connection: 'x-remove', 'X-Remove': 'bad', Cookie: ['session=one', 'csrf=two'], Origin: 'https://foreign.example' } })
  assert.equal(captured['x-remove'], undefined)
  assert.equal(captured.cookie, 'session=one; csrf=two')
  assert.equal(captured.origin, 'https://foreign.example')
  assert.equal(result.headers['x-private'], undefined)
  assert.deepEqual(result.headers['set-cookie'], ['session=one; Path=/; HttpOnly', 'csrf=two; Path=/; SameSite=Strict'])
})

test('cancellation interrupts a stalled response reader', async () => {
  const controller = new AbortController()
  let cancelled = false
  const adapter = createGatewayAdapter({ target: 'http://127.0.0.1:1', fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true } })) })
  const request = adapter.forwardHttp({ path: '/', signal: controller.signal })
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort(new Error('cancelled request'))
  await assert.rejects(request, /cancelled request/)
  assert.equal(cancelled, true)
})

test('malformed headers, fragments, traversal and unsafe methods fail before fetch', async () => {
  const adapter = createGatewayAdapter({ target: 'http://127.0.0.1:1', fetchImpl() { throw new Error('must not fetch') } })
  for (const path of ['/x/../admin', '/x/%2e%2e/admin', '/foo#fragment', '/with space']) await assert.rejects(adapter.forwardHttp({ path }), /invalid gateway path/)
  for (const headers of [{ 'bad name': 'x' }, { ok: 'bad\r\ninjected: 1' }, { connection: 'bad token' }, { ok: [1] }]) await assert.rejects(adapter.forwardHttp({ path: '/', headers }), /invalid gateway/)
  await assert.rejects(adapter.forwardHttp({ path: '/', method: 'CONNECT' }), /method/)
  await assert.rejects(adapter.forwardHttp({ path: '/', body: 'a' }), /cannot have a body/)
})

test('HEAD metadata retains representation length without buffering its absent body', async () => {
  const adapter = createGatewayAdapter({ target: 'http://127.0.0.1:1', maxResponseBytes: 4, fetchImpl: async () => new Response(null, { headers: { 'content-length': '100', 'content-encoding': 'gzip' } }) })
  const result = await adapter.forwardHttp({ path: '/', method: 'HEAD' })
  assert.equal(result.headers['content-length'], '100')
  assert.equal(result.headers['content-encoding'], 'gzip')
  assert.equal(result.body.byteLength, 0)
})
