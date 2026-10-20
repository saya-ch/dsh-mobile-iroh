import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { createSidecarFixtureRoot, startPhone } from './first-party-fixture.mjs'

test('fixture owns a fresh home child and lets Rust create private state subdirectories', async () => {
  const owned = await createSidecarFixtureRoot('unit-root-check')
  try {
    assert.equal(dirname(owned.directory), resolve(homedir()))
    assert.ok(basename(owned.directory).startsWith('.dsh-mobile-iroh-unit-root-check-'))
    assert.deepEqual(await readdir(owned.directory), [])
  } finally { await owned.cleanup() }
  await assert.rejects(access(owned.directory))
  await owned.cleanup()
})

test('fixture labels cannot escape or broaden the cleanup target', async () => {
  for (const label of ['', '../outside', '..', 'Uppercase', 'x'.repeat(49), 'x\\outside']) {
    await assert.rejects(createSidecarFixtureRoot(label), /invalid sidecar fixture label/)
  }
})

function phoneProcess({ exitsOnEof = true } = {}) {
  const child = new EventEmitter()
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = []
  child.endCount = 0
  child.stdin = new Writable({
    write(_chunk, _encoding, done) { done() },
    final(done) { child.endCount += 1; done(); if (exitsOnEof) setImmediate(() => child.emit('close', 0, null)) },
  })
  child.kill = (signal = 'SIGTERM') => { child.kills.push(signal); setImmediate(() => child.emit('close', null, signal)); return true }
  queueMicrotask(() => child.stdout.write('{"version":1,"type":"proxy-ready","origin":"http://127.0.0.1:25443"}\n'))
  return child
}
const phoneOptions = (child, overrides = {}) => ({ executable: resolve('transport-sim.exe'), dataDir: resolve('unused-data'), endpointId: 'a'.repeat(64), peerAddresses: ['127.0.0.1:30000'], spawnImpl: () => child, stopTimeoutMs: 10, ...overrides })

test('Android transport driver receives stdin EOF and exits before any forced kill', async () => {
  const child = phoneProcess()
  let options
  const phone = await startPhone(phoneOptions(child, { gracefulStdin: true, spawnImpl: (_file, _args, spawned) => { options = spawned; return child } }))
  const results = await Promise.all([phone.stop(), phone.stop()])
  assert.equal(options.stdio[0], 'pipe')
  assert.equal(child.endCount, 1)
  assert.deepEqual(child.kills, [])
  assert.equal(results[0].exitCode, 0)
  assert.equal(phone.exited, true)
})

test('a driver ignoring EOF is terminated only after its grace budget', async () => {
  const child = phoneProcess({ exitsOnEof: false })
  const phone = await startPhone(phoneOptions(child, { gracefulStdin: true }))
  await phone.stop()
  assert.equal(child.endCount, 1)
  assert.deepEqual(child.kills, ['SIGTERM'])
})

test('legacy phone fixture keeps immediate termination unless graceful stdin is explicit', async () => {
  const child = phoneProcess()
  let options
  const phone = await startPhone(phoneOptions(child, { spawnImpl: (_file, _args, spawned) => { options = spawned; return child } }))
  await phone.stop()
  assert.equal(options.stdio[0], 'ignore')
  assert.equal(child.endCount, 0)
  assert.deepEqual(child.kills, ['SIGTERM'])
})

test('EndpointId-only discovery is explicit and never accepted for local-only fixtures', async () => {
  const child = phoneProcess()
  let args
  const phone = await startPhone(phoneOptions(child, { peerAddresses: [], localOnly: false, spawnImpl: (_file, values) => { args = values; return child } }))
  assert.equal(args.includes('--peer-address'), false)
  assert.equal(args.includes('--local-only'), false)
  await phone.stop()
  await assert.rejects(startPhone(phoneOptions(phoneProcess(), { peerAddresses: [], localOnly: true })), /invalid first-party phone fixture/)
})
