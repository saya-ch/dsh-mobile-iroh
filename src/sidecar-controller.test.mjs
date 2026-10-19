import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeCommand, validateProxyTarget } from './sidecar-controller.mjs'

test('sidecar target accepts only explicit loopback HTTP origins', () => {
  assert.equal(validateProxyTarget('http://127.0.0.1:3080'), 'http://127.0.0.1:3080')
  assert.equal(validateProxyTarget('http://[::1]:3080'), 'http://[::1]:3080')
  assert.throws(() => validateProxyTarget('https://127.0.0.1:3080'), /HTTP loopback/)
  assert.throws(() => validateProxyTarget('http://localhost:3080'), /HTTP loopback/)
  assert.throws(() => validateProxyTarget('http://127.0.0.1:3080/path'), /HTTP loopback/)
})

test('sidecar commands are one bounded JSON line', () => {
  assert.equal(encodeCommand({ type: 'pairing-begin' }), '{"type":"pairing-begin"}\n')
  assert.throws(() => encodeCommand({ type: 'x'.repeat(20_000) }), /too large/)
  assert.throws(() => encodeCommand(null), /invalid sidecar command/)
})
