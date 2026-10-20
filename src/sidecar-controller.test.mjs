import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { resolve } from 'node:path'
import { decodeSidecarEvent, encodeCommand, MAX_LINE_BYTES, resolveSidecarIdentity, SidecarController, validateProxyTarget } from './sidecar-controller.mjs'

const id = 'a'.repeat(64)
const ready = { version: 1, type: 'ready', endpoint_id: id, direct_addresses: ['127.0.0.1:17000'], local_only: true }
const line = (event) => `${JSON.stringify(event)}\n`
const tick = () => new Promise((resolve) => setImmediate(resolve))
function fakeChild({ autoClose = true, onStart } = {}) {
  const child = new EventEmitter()
  child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.commands = []; child.kills = []
  child.close = (code = 0) => { child.exitCode = code; child.emit('close', code, null) }
  child.stdin = new Writable({ write(chunk, _encoding, callback) { child.commands.push(chunk.toString()); callback() }, final(callback) { callback(); if (autoClose) setImmediate(() => child.close()) } })
  child.kill = (signal = 'SIGTERM') => { child.kills.push(signal); if (autoClose) setImmediate(() => child.close()); return true }
  child.exitCode = null
  if (onStart) queueMicrotask(() => onStart(child))
  return child
}
const controllerFor = (child, options = {}) => new SidecarController({ executable: resolve('sidecar.exe'), dataDir: resolve('data'), proxyTarget: 'https://127.0.0.1:3443', spawnImpl: () => child, readyTimeoutMs: 100, stopTimeoutMs: 10, ...options })

test('sidecar target permits HTTP or raw TLS only on explicit loopback origins', () => {
  assert.equal(validateProxyTarget('http://127.0.0.1:3080'), 'http://127.0.0.1:3080')
  assert.equal(validateProxyTarget('https://[::1]:3443'), 'https://[::1]:3443')
  for (const target of ['http://localhost:3080', 'http://127.0.0.1:3080/path', 'http://example.com:3080', 'file:///tmp/x']) assert.throws(() => validateProxyTarget(target), /loopback/)
})

test('identity preparation accepts exactly one bounded endpoint ID after process exit', async () => {
  const child = fakeChild({ onStart(child) { child.stdout.write(`${id}\n`); child.close() } })
  assert.equal(await resolveSidecarIdentity({ executable: resolve('sidecar.exe'), dataDir: resolve('data'), spawnImpl: () => child }), id)
  for (const value of [`${id}\n${id}`, 'a'.repeat(129), Buffer.alloc(64, 0xe1)]) {
    const invalid = fakeChild({ onStart(child) { child.stdout.write(value); child.close() } })
    await assert.rejects(resolveSidecarIdentity({ executable: resolve('sidecar.exe'), dataDir: resolve('data'), spawnImpl: () => invalid }), /invalid|too large/)
  }
})

test('identity timeout reaps its child and does not return a partial ID', async () => {
  const child = fakeChild()
  await assert.rejects(resolveSidecarIdentity({ executable: resolve('sidecar.exe'), dataDir: resolve('data'), spawnImpl: () => child, timeoutMs: 10, stopTimeoutMs: 10 }), /identity timeout/)
  assert.notEqual(child.exitCode, null)
})

test('versioned commands reject removed authority injection and unknown fields', () => {
  assert.equal(encodeCommand({ version: 1, type: 'pairing-begin' }), '{"version":1,"type":"pairing-begin"}\n')
  assert.equal(JSON.parse(encodeCommand({ version: 1, type: 'device-forget', id })).id, id)
  for (const invalid of [null, { type: 'device-list' }, { version: 2, type: 'shutdown' }, { version: 1, type: 'proxy-auth' }, { version: 1, type: 'device-list', extra: true }, { version: 1, type: 'device-forget', id: 'bad' }]) assert.throws(() => encodeCommand(invalid), /invalid sidecar/)
})

test('stdout events reject unknown versions, fields, IDs, or oversized values', () => {
  assert.deepEqual(decodeSidecarEvent(JSON.stringify(ready)), ready)
  assert.ok(Object.isFrozen(decodeSidecarEvent(JSON.stringify(ready)).direct_addresses))
  for (const event of [{ ...ready, extra: 1 }, { ...ready, version: 2 }, { ...ready, endpoint_id: 'x' }, { ...ready, direct_addresses: ['evil.example:33'] }, { version: 1, type: 'devices', devices: [{ id, name: 'ok', paired_at: 'now', online: true, token: 'no' }] }, { version: 1, type: 'pairing', code: '123456', expires_in_sec: 0 }, { version: 1, type: 'decision' }]) assert.throws(() => decodeSidecarEvent(JSON.stringify(event)), /invalid/)
  assert.throws(() => decodeSidecarEvent('x'.repeat(MAX_LINE_BYTES + 1)), /too large/)
})

test('startup uses first-party CLI, fragments JSON safely, and bounds observer history', async () => {
  let args, spawnOptions
  const child = fakeChild()
  const controller = controllerFor(child, { maxEvents: 2, spawnImpl: (_file, values, options) => { args = values; spawnOptions = options; return child } })
  controller.onEvent(() => { throw new Error('observer failure') })
  const started = controller.start({ pair: true, localOnly: true })
  const encoded = line(ready)
  child.stdout.write(encoded.slice(0, 20)); child.stdout.write(encoded.slice(20))
  assert.deepEqual(await started, ready)
  assert.ok(args.includes('--local-only')); assert.ok(args.includes('--pair')); assert.ok(args.includes('127.0.0.1:3443'))
  assert.equal(spawnOptions.windowsHide, true)
  controller.send({ version: 1, type: 'device-list' })
  child.stdout.write(line({ version: 1, type: 'pairing-closed', reason: 'expired' }).repeat(4))
  assert.equal(controller.events.length, 2)
  await Promise.all([controller.stop(), controller.stop()])
  assert.equal(child.commands.filter((value) => value.includes('shutdown')).length, 1)
  assert.deepEqual(child.kills, [])
})

test('oversized unterminated input is rejected before ready and startup reaps process', async () => {
  const child = fakeChild({ onStart: (child) => child.stdout.write(Buffer.alloc(MAX_LINE_BYTES + 1, 120)) })
  const controller = controllerFor(child)
  await assert.rejects(controller.start(), /line_too_large/)
  assert.notEqual(child.exitCode, null)
  assert.ok(controller.events.some((event) => event.code === 'line_too_large'))
})

test('invalid UTF-8 and versioned JSON close the owned process without observer exceptions', async () => {
  for (const payload of [Buffer.from([0xff, 10]), Buffer.from(line({ ...ready, version: 2 }))]) {
    const child = fakeChild({ onStart: (child) => child.stdout.write(payload) })
    const controller = controllerFor(child)
    await assert.rejects(controller.start(), /invalid_/)
    assert.notEqual(child.exitCode, null)
  }
})

test('ready timeout shuts down and permits a clean later start', async () => {
  const first = fakeChild()
  const second = fakeChild()
  let spawns = 0
  const controller = controllerFor(first, { readyTimeoutMs: 10, spawnImpl: () => ++spawns === 1 ? first : second })
  await assert.rejects(controller.start(), /ready timeout/)
  const restart = controller.start()
  second.stdout.write(line(ready))
  await restart
  await controller.stop()
  assert.notEqual(first.exitCode, null); assert.notEqual(second.exitCode, null)
})

test('failed spawn is handled without an unhandled error or orphan', async () => {
  const child = fakeChild({ onStart: (child) => { child.emit('error', new Error('ENOENT')); child.close(-2) } })
  const controller = controllerFor(child)
  await assert.rejects(controller.start(), /process_error|process failed/)
  await controller.stop()
})

test('stop during startup cannot strand the readiness promise', async () => {
  const child = fakeChild()
  const controller = controllerFor(child)
  const pending = controller.start()
  const rejected = assert.rejects(pending, /stopped during startup|exited before ready/)
  await controller.stop(); await rejected
})

test('stop wins over a late ready event and old pairing events do not survive restart', async () => {
  const first = fakeChild(), second = fakeChild()
  let spawns = 0
  const controller = controllerFor(first, { spawnImpl: () => ++spawns === 1 ? first : second })
  const start = controller.start()
  const rejected = assert.rejects(start, /stopped during startup/)
  const stopping = controller.stop()
  first.stdout.write(line({ version: 1, type: 'pairing', code: '123456', expires_in_sec: 30 }))
  first.stdout.write(line(ready))
  await stopping; await rejected
  const restart = controller.start()
  second.stdout.write(line(ready)); await restart
  assert.equal(controller.events.some((event) => event.type === 'pairing'), false)
  await controller.stop()
})

test('stdin backpressure has a bounded aggregate queue', async () => {
  const child = fakeChild()
  child.stdin = new Writable({ write(_chunk, _encoding, _callback) {} })
  const controller = controllerFor(child)
  const starting = controller.start(); child.stdout.write(line(ready)); await starting
  let accepted = 0
  assert.throws(() => {
    for (let index = 0; index < 10000; index += 1) { controller.send({ version: 1, type: 'device-list' }); accepted += 1 }
  }, /buffer is full/)
  assert.ok(accepted > 0)
  assert.ok(child.stdin.writableLength <= 64 * 1024)
  await controller.stop()
})

test('unresponsive process receives bounded escalation and ownership is retained', async () => {
  const child = fakeChild({ autoClose: false })
  const controller = controllerFor(child)
  const startup = controller.start(); child.stdout.write(line(ready)); await startup
  await assert.rejects(controller.stop(), /did not exit/)
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL'])
  await assert.rejects(controller.start(), /already started/)
  child.close(); await tick(); await controller.stop()
})
