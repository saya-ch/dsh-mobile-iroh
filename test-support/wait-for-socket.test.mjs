import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { waitForSocketEvent } from './wait-for-socket.mjs'

test('silent or prematurely closed fixture sockets fail within their owner budget', async () => {
  const silent = new EventEmitter()
  await assert.rejects(waitForSocketEvent(silent, 'message', { timeoutMs: 10 }), /fixture budget/)
  assert.equal(silent.eventNames().length, 0)
  const closed = new EventEmitter()
  const result = waitForSocketEvent(closed, 'message')
  closed.emit('close')
  await assert.rejects(result, /closed before message/)
  assert.equal(closed.eventNames().length, 0)
})

test('expected response, socket failure and selection failure remove only owned listeners', async () => {
  const socket = new EventEmitter(), observer = () => {}
  socket.on('close', observer)
  const response = waitForSocketEvent(socket, 'unexpected-response', { select: (_request, value) => value.statusCode })
  socket.emit('unexpected-response', {}, { statusCode: 404 })
  assert.equal(await response, 404)
  assert.deepEqual(socket.listeners('close'), [observer])
  const failed = waitForSocketEvent(socket, 'open')
  socket.emit('error', new Error('handshake failed'))
  await assert.rejects(failed, /handshake failed/)
  const selection = waitForSocketEvent(socket, 'message', { select: () => { throw new Error('bad echo') } })
  socket.emit('message', 'unexpected')
  await assert.rejects(selection, /bad echo/)
  assert.deepEqual(socket.eventNames(), ['close'])
})

test('an unauthorized successful upgrade fails immediately rather than waiting for timeout', async () => {
  const socket = new EventEmitter()
  const denied = waitForSocketEvent(socket, 'unexpected-response', { rejectEvents: ['open'] })
  socket.emit('open')
  await assert.rejects(denied, /Unexpected socket open/)
  assert.equal(socket.eventNames().length, 0)
})
