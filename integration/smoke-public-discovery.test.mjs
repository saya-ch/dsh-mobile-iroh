import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { cleanupPublicProbe, createPublicProcessOwner, runWithPublicBudget } from './smoke-public-discovery.mjs'

function child({ closes = true } = {}) {
  const process = new EventEmitter()
  process.stderr = new PassThrough()
  process.kill = () => { if (closes) setImmediate(() => process.emit('close', null, 'SIGKILL')); return true }
  return process
}

test('public process owner retains close receipts even when a child exits before cleanup', async () => {
  const process = child()
  const owner = createPublicProcessOwner({ spawnImpl: () => process, diagnosticLimit: 8 })
  owner.launch('phone', 'unused', [], {})
  process.stderr.write('0123456789')
  process.emit('close', 7, null)
  assert.deepEqual(await owner.drain(10), [])
  assert.equal(owner.diagnostics.get('phone').toString(), '23456789')
  assert.deepEqual(owner.exits(), [{ label: 'phone', closed: true, code: 7, signal: null }])
  assert.throws(() => owner.launch('late', 'unused', [], {}), /closing/u)
})

test('public process cleanup requires actual close rather than a successful kill signal', async () => {
  const process = child({ closes: false })
  const owner = createPublicProcessOwner({ spawnImpl: () => process })
  owner.launch('phone', 'unused', [], {})
  const order = []
  const cleanup = await cleanupPublicProbe({ processes: owner, drainTimeoutMs: 10,
    owned: { directory: '/owned', cleanup: async () => order.push('remove') },
    closeOwners: [async () => order.push('owner')], closeUpstream: async () => order.push('upstream') })
  assert.equal(cleanup.cleanupComplete, false)
  assert.equal(cleanup.preservedFixtureRoot, '/owned')
  assert.deepEqual(order, ['owner', 'upstream'])
  process.emit('close', null, 'SIGKILL')
  assert.deepEqual(await owner.drain(10), [])
})

test('public work expiration cancels and drains the losing promise before returning', async () => {
  const order = []
  let finish
  const pending = runWithPublicBudget(async () => { await new Promise(resolve => { finish = resolve }); order.push('work-drained') },
    { timeoutMs: 10, drainTimeoutMs: 50, cancel: () => { order.push('cancel'); finish() } })
  await assert.rejects(pending, error => { assert.equal(error.publicBudgetExpired, true); assert.equal(error.workDrained, true); return true })
  assert.deepEqual(order, ['cancel', 'work-drained'])
})

test('undrained work retains private state even after every child closes', async () => {
  let finish
  await assert.rejects(runWithPublicBudget(() => new Promise(resolve => { finish = resolve }),
    { timeoutMs: 10, drainTimeoutMs: 10, cancel() {} }), error => { assert.equal(error.workDrained, false); return true })
  let removed = false
  const cleanup = await cleanupPublicProbe({ workDrained: false, processes: { drain: async () => [] }, closeOwners: [], closeUpstream: async () => {},
    owned: { directory: '/owned', cleanup: async () => { removed = true } } })
  assert.equal(cleanup.cleanupComplete, false); assert.equal(removed, false)
  finish()
})

test('controller cleanup failure retains state; successful cleanup removes it last', async () => {
  const order = []
  const options = { processes: { drain: async () => { order.push('process-drain'); return [] } }, closeUpstream: async () => order.push('upstream'),
    owned: { directory: '/owned', cleanup: async () => order.push('remove') } }
  const failed = await cleanupPublicProbe({ ...options, closeOwners: [async () => { throw new Error('still owned') }] })
  assert.equal(failed.cleanupComplete, false); assert.equal(order.includes('remove'), false)
  order.length = 0
  const passed = await cleanupPublicProbe({ ...options, closeOwners: [async () => order.push('controller')] })
  assert.equal(passed.cleanupComplete, true)
  assert.deepEqual(order, ['controller', 'process-drain', 'upstream', 'remove'])
})
