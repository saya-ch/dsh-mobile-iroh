// These vectors do not validate the Rust QUIC or parent-process wire protocols.
import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeControlMessage, encodeControlMessage, ReplayWindow } from './control-protocol.mjs'

const message = {
  version: 1,
  type: 'open-stream',
  requestId: 'req-1',
  nonce: 'nonce-1',
  payload: { route: '/api/session', method: 'GET' },
}

test('control messages use deterministic key ordering and round-trip', () => {
  const encoded = encodeControlMessage(message)
  assert.equal(encoded, '{"nonce":"nonce-1","payload":{"method":"GET","route":"/api/session"},"requestId":"req-1","type":"open-stream","version":1}')
  assert.deepEqual(decodeControlMessage(encoded), message)
})

test('unknown fields, versions, and types fail closed', () => {
  assert.throws(() => decodeControlMessage(JSON.stringify({ ...message, extra: true })), /invalid_message_fields/)
  assert.throws(() => encodeControlMessage({ ...message, version: 2 }), /unsupported_protocol_version/)
  assert.throws(() => encodeControlMessage({ ...message, type: 'arbitrary-route' }), /unsupported_message_type/)
})

test('replay window rejects duplicates and expires entries', () => {
  let now = 100
  const window = new ReplayWindow({ now: () => now, ttlMs: 10, maxEntries: 2 })
  assert.equal(window.accept('one'), true)
  assert.equal(window.accept('one'), false)
  now = 111
  assert.equal(window.accept('one'), true)
  assert.equal(window.accept('two'), true)
  assert.equal(window.accept('three'), false)
  assert.equal(window.accept('one'), false)
  now = 122
  assert.equal(window.accept('three'), true)
})
