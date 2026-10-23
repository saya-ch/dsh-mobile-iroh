import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { join, resolve } from 'node:path'
import { access } from 'node:fs/promises'
import { NativePreferenceError, NativePreferenceStore } from './native-preference-store.mjs'
import { createSidecarFixtureRoot } from '../src/first-party-fixture.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const state = enabled => ({ version: 1, enabled })
const output = enabled => `${JSON.stringify(state(enabled))}\n`
const hasCode = code => error => error instanceof NativePreferenceError && error.code === code

function childProcess({ killCloses = true } = {}) {
  const child = new EventEmitter()
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = []
  child.closed = false
  child.close = (code = 0, signal = null) => { child.closed = true; child.emit('close', code, signal) }
  child.kill = (signal = 'SIGTERM') => {
    child.kills.push(signal)
    if (killCloses) queueMicrotask(() => child.close(null, signal))
    return true
  }
  return child
}

const options = (spawnImpl, extra = {}) => ({ executable: resolve('host.exe'), dataDirectory: resolve('unused-preference-profile'), spawnImpl, timeoutMs: 1000, stopTimeoutMs: 15, ...extra })

test('native preference commands are inert, serialized, fixed-path and require actual child close', async () => {
  const children = [], calls = []
  const store = new NativePreferenceStore(options((file, args, spawned) => {
    const child = childProcess(); children.push(child); calls.push({ file, args, spawned }); return child
  }))
  assert.equal(children.length, 0)
  const first = store.load(), second = store.save(state(true))
  await tick(); assert.equal(children.length, 1)
  let settled = false
  void first.then(() => { settled = true })
  children[0].stdout.write(output(false)); children[0].emit('exit', 0, null)
  await tick(); assert.equal(settled, false); assert.equal(children.length, 1)
  children[0].close()
  assert.deepEqual(await first, state(false))
  await tick(); assert.equal(children.length, 2)
  children[1].stdout.write(output(true)); children[1].close()
  assert.deepEqual(await second, state(true))
  assert.deepEqual(calls[0].args, ['--lang', 'en', 'preference-load', '--data-dir', resolve('unused-preference-profile')])
  assert.deepEqual(calls[1].args.slice(-2), ['--enabled', 'true'])
  assert.equal(calls[0].spawned.windowsHide, true)
  assert.deepEqual(calls[0].spawned.stdio, ['ignore', 'pipe', 'pipe'])
  assert.equal(JSON.stringify(store), '{}')
  await store.close()
})

test('strict state validation rejects unknown or malformed values before spawning', async () => {
  let spawns = 0
  const store = new NativePreferenceStore(options(() => { spawns += 1; throw new Error('must not spawn') }))
  for (const invalid of [null, [], { enabled: true }, { version: 2, enabled: true }, { version: 1, enabled: 'true' }, { version: 1, enabled: true, filename: 'outside' }]) {
    await assert.rejects(store.save(invalid), hasCode('invalid_preference_state'))
  }
  assert.equal(spawns, 0)
  await store.close()
})

test('native responses reject extra records, fields, invalid UTF-8 and mismatched save acknowledgements', async () => {
  for (const value of [output(false) + output(false), '{"version":1,"enabled":false,"other":1}\n', '{"version":2,"enabled":false}\n', '{"version":1,"enabled":false,"enabled":true}\n', Buffer.from([0xff, 10]), output(true).trim()]) {
    const child = childProcess()
    const store = new NativePreferenceStore(options(() => child))
    const load = store.load(); await tick(); child.stdout.write(value); child.close()
    await assert.rejects(load, hasCode('invalid_preference_response')); await store.close()
  }
  const child = childProcess(), store = new NativePreferenceStore(options(() => child))
  const save = store.save(state(true)); await tick(); child.stdout.write(output(false)); child.close()
  await assert.rejects(save, hasCode('invalid_preference_response')); await store.close()
})

test('oversized output is stopped before close and is never included in an error', async () => {
  const child = childProcess({ killCloses: false }), store = new NativePreferenceStore(options(() => child))
  const pending = store.load(), rejected = assert.rejects(pending, hasCode('preference_output_too_large'))
  await tick(); child.stdout.write('private-output-sentinel'.repeat(100))
  await tick(); assert.deepEqual(child.kills, ['SIGTERM'])
  child.close(null, 'SIGTERM'); await rejected; await store.close()
})

test('timeout and cancellation wait for child close instead of only requesting termination', async () => {
  for (const cancellation of [false, true]) {
    const child = childProcess({ killCloses: false }), abort = new AbortController()
    const store = new NativePreferenceStore(options(() => child, { timeoutMs: cancellation ? 1000 : 15, stopTimeoutMs: 100 }))
    const pending = store.load({ signal: abort.signal })
    const rejected = assert.rejects(pending, hasCode(cancellation ? 'preference_operation_cancelled' : 'preference_operation_timeout'))
    await tick()
    if (cancellation) abort.abort()
    else await new Promise(resolve => setTimeout(resolve, 30))
    assert.deepEqual(child.kills, ['SIGTERM']); assert.equal(child.closed, false)
    child.emit('exit', null, 'SIGTERM'); await tick(); assert.equal(child.closed, false)
    child.close(null, 'SIGTERM'); await rejected; await store.close()
  }
})

test('a queued cancelled operation cannot spawn after its predecessor closes', async () => {
  const child = childProcess(), abort = new AbortController(); let spawns = 0
  const store = new NativePreferenceStore(options(() => { spawns += 1; return child }))
  const first = store.load(), second = store.save(state(true), { signal: abort.signal })
  const rejected = assert.rejects(second, hasCode('preference_operation_cancelled'))
  abort.abort(); await tick(); child.stdout.write(output(false)); child.close()
  await first; await rejected; assert.equal(spawns, 1); await store.close()
})

test('failed termination retains ownership, blocks new commands and allows explicit close to retry', async () => {
  const child = childProcess({ killCloses: false }), store = new NativePreferenceStore(options(() => child, { timeoutMs: 10, stopTimeoutMs: 10 }))
  await assert.rejects(store.load(), hasCode('preference_process_not_closed'))
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL'])
  await assert.rejects(store.load(), hasCode('preference_process_not_closed'))
  const closing = store.close(); await tick(); child.close(null, 'SIGTERM'); await closing
  await assert.rejects(store.load(), hasCode('preference_store_closed'))
})

test('nonzero saves and spawn failures are redacted and never replayed', async () => {
  let spawns = 0
  const child = childProcess(), store = new NativePreferenceStore(options(() => { spawns += 1; return child }))
  const saving = store.save(state(true)); await tick()
  child.stderr.write('credential-path-sentinel'); child.stdout.write(output(true)); child.close(1)
  await assert.rejects(saving, hasCode('preference_process_failed')); assert.equal(spawns, 1); await store.close()
  const failed = new NativePreferenceStore(options(() => { throw new Error('credential-path-sentinel') }))
  await assert.rejects(failed.load(), hasCode('preference_process_failed')); await failed.close()
})

test('store close cancels in-flight and queued work, retaining no successful late response', async () => {
  const child = childProcess({ killCloses: false }); let spawns = 0
  const store = new NativePreferenceStore(options(() => { spawns += 1; return child }))
  const first = store.load(), second = store.save(state(true))
  const rejectedFirst = assert.rejects(first, hasCode('preference_store_closed'))
  const rejectedSecond = assert.rejects(second, hasCode('preference_store_closed'))
  await tick(); const closing = store.close(); child.stdout.write(output(false)); child.close()
  await closing; await rejectedFirst; await rejectedSecond; assert.equal(spawns, 1)
})

test('first-party executable persists state across adapter instances without creating an endpoint', { skip: !process.env.DSH_IROH_TEST_HOST_BINARY }, async () => {
  const owned = await createSidecarFixtureRoot('native-preference-test'), dataDirectory = join(owned.directory, 'host')
  const executable = process.env.DSH_IROH_TEST_HOST_BINARY
  const stores = []
  try {
    const first = new NativePreferenceStore({ executable, dataDirectory }); stores.push(first)
    assert.deepEqual(await first.load(), state(false)); await first.save(state(true)); await first.close()
    const restored = new NativePreferenceStore({ executable, dataDirectory }); stores.push(restored)
    assert.deepEqual(await restored.load(), state(true)); await restored.save(state(false)); await restored.close()
    const disabled = new NativePreferenceStore({ executable, dataDirectory }); stores.push(disabled)
    assert.deepEqual(await disabled.load(), state(false))
    await assert.rejects(access(join(dataDirectory, 'identity.key')), { code: 'ENOENT' })
  } finally {
    await Promise.all(stores.map(store => store.close()))
    await owned.cleanup()
  }
})
