import assert from 'node:assert/strict'
import test from 'node:test'
import { createExtensionHost } from './extension-host.mjs'

function fixture({ stopFailures = 0 } = {}) {
  const effects = [], entries = new Map(), events = []
  class Context {
    effect(setup) { const dispose = setup(); effects.push(dispose) }
    fiber = { dispose: async () => { events.push('context-dispose'); for (const dispose of effects.splice(0).reverse()) await dispose() } }
  }
  const service = {
    status: () => ({ loaded: entries.size, failed: 0 }),
    registerExtension(definition) {
      if (entries.has(definition.id)) throw new Error('duplicate')
      entries.set(definition.id, definition)
      return () => { entries.delete(definition.id); events.push(`remove:${definition.id}`) }
    },
    async startLocal(directory, context, options) { events.push({ directory, context: context instanceof Context, options }) },
    async stopLocal() { events.push('local-stop'); if (stopFailures-- > 0) throw new Error('stop failed') },
  }
  return { Context, mobile: { createMobileAccessService: () => service }, service, events, entries }
}

test('extension host registers actual provider definitions as Context effects and stops service first', async () => {
  const runtime = fixture()
  const owner = await createExtensionHost({ ...runtime, providers: [({ registerExtension }) => {
    registerExtension({ id: 'owned' })
    return () => runtime.events.push('provider-dispose')
  }] })
  assert.equal(owner.service, runtime.service)
  assert.deepEqual([...runtime.entries.keys()], ['owned'])
  assert.deepEqual(owner.status(), { loaded: 1, failed: 0 })
  assert.equal(owner.close(), owner.close())
  await owner.close()
  assert.equal(runtime.entries.size, 0)
  assert.deepEqual(runtime.events, ['local-stop', 'context-dispose', 'provider-dispose', 'remove:owned'])
  await assert.rejects(async () => owner.registerExtension({ id: 'late' }), /closing/u)
})

test('failed local close retains Context and allows cleanup retry', async () => {
  const runtime = fixture({ stopFailures: 1 })
  const owner = await createExtensionHost(runtime)
  await assert.rejects(owner.close(), /stop failed/u)
  assert.deepEqual(runtime.events, ['local-stop'])
  await owner.close()
  assert.deepEqual(runtime.events, ['local-stop', 'local-stop', 'context-dispose'])
})

test('failed provider activation cleans previously registered providers', async () => {
  const runtime = fixture()
  await assert.rejects(createExtensionHost({ ...runtime, providers: [({ registerExtension }) => {
    registerExtension({ id: 'partial' }); throw new Error('activation failed')
  }] }), /activation failed/u)
  assert.equal(runtime.entries.size, 0)
  assert.deepEqual(runtime.events, ['local-stop', 'context-dispose', 'remove:partial'])
})

test('failed startup cleanup returns its retained owner for explicit cleanup retry', async () => {
  const runtime = fixture({ stopFailures: 1 })
  let retained
  await assert.rejects(createExtensionHost({ ...runtime, providers: [({ registerExtension }) => {
    registerExtension({ id: 'partial' }); throw new Error('activation failed')
  }] }), error => {
    assert.equal(error.preserveFixtureRoot, true)
    retained = error.extensionHost
    assert.equal(retained.service, runtime.service)
    return true
  })
  assert.equal(runtime.entries.size, 1)
  assert.deepEqual(runtime.events, ['local-stop'])
  await retained.close()
  assert.equal(runtime.entries.size, 0)
})

test('local extensions use the public service with an explicit absolute root and execution options', async () => {
  const runtime = fixture()
  const localDirectory = process.cwd()
  const owner = await createExtensionHost({ ...runtime, localDirectory, hostExecution: { mode: 'worker' } })
  assert.deepEqual(runtime.events[0], { directory: localDirectory, context: true, options: { hostExecution: { mode: 'worker' } } })
  await owner.close()
  await assert.rejects(createExtensionHost({ ...runtime, localDirectory: 'relative' }), /Invalid/u)
  await assert.rejects(createExtensionHost({ ...runtime, hostExecution: {} }), /explicit extension directory/u)
  await assert.rejects(createExtensionHost({ mobile: {}, Context: runtime.Context }), /Invalid/u)
})
