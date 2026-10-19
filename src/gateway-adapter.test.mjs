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
