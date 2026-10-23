import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { access } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { NativeConfigStore,validateOperatorConfig } from './native-config-store.mjs'
import { createSidecarFixtureRoot } from '../src/first-party-fixture.mjs'

const config = { version:1,upstreamOrigin:'http://127.0.0.1:9555',localPort:28443,localOnly:true }
const tick = () => new Promise(resolve => setImmediate(resolve))
function childProcess() {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.kill = signal => { queueMicrotask(() => child.emit('close',null,signal ?? 'SIGTERM')); return true }
  return child
}
const options = spawnImpl => ({ executable:resolve('fixture/host.exe'),dataDirectory:resolve('fixture/private'),spawnImpl })

test('fixed non-secret settings reject auth material, paths, alternate hosts and noncanonical Origins',() => {
  assert.deepEqual(validateOperatorConfig(config),config)
  for (const value of [{ ...config,token:'secret' },{ ...config,localOnly:'true' },{ ...config,localPort:0 },...['http://localhost:9555','http://127.0.0.1:9555/','http://127.0.0.1:9555/?token=x','http://127.0.0.1:80','https://127.0.0.1/#x','http://user:pass@127.0.0.1','http://evil.invalid'].map(upstreamOrigin => ({ ...config,upstreamOrigin }))]) assert.throws(() => validateOperatorConfig(value))
})

test('load absence and save use only fixed native commands and canonical response acknowledgements',async () => {
  const children = [],calls = []
  const store = new NativeConfigStore(options((file,args) => { const child = childProcess(); children.push(child); calls.push(args); return child }))
  const load = store.load(); await tick(); children[0].stdout.write('null\n'); children[0].emit('close',0,null); assert.equal(await load,null)
  const save = store.save(config); await tick(); children[1].stdout.write(`${JSON.stringify(config)}\n`); children[1].emit('close',0,null); assert.deepEqual(await save,config)
  assert.deepEqual(calls[1],['--lang','en','operator-config-save','--data-dir',resolve('fixture/private'),'--upstream-origin',config.upstreamOrigin,'--local-port','28443','--local-only','true'])
  await store.close()
})

test('unknown fields, malformed UTF-8, duplicate members, changed acknowledgements and overlong output fail redacted',async () => {
  for (const output of [JSON.stringify({ ...config,secret:'PRIVATE' })+'\n',JSON.stringify({ ...config,localPort:28444 })+'\n','{"version":1,"version":1}\n',Buffer.from([255,10]),'PRIVATE'.repeat(300)]) {
    const child = childProcess(),store = new NativeConfigStore(options(() => child))
    const operation = store.save(config),rejected = assert.rejects(operation,error => { assert.doesNotMatch(error.message,/PRIVATE/u); return true })
    await tick(); child.stdout.write(output); child.emit('close',0,null); await rejected; await store.close()
  }
})

test('real config storage survives a fresh owner and never creates identity or TLS', { skip:!process.env.DSH_IROH_TEST_HOST_BINARY },async () => {
  const owned = await createSidecarFixtureRoot('operator-config-test'),stores = [],dataDirectory = join(owned.directory,'host')
  try {
    const first = new NativeConfigStore({ executable:process.env.DSH_IROH_TEST_HOST_BINARY,dataDirectory }); stores.push(first)
    assert.equal(await first.load(),null); await first.save(config); await first.close()
    const second = new NativeConfigStore({ executable:process.env.DSH_IROH_TEST_HOST_BINARY,dataDirectory }); stores.push(second)
    assert.deepEqual(await second.load(),config)
    await assert.rejects(access(join(dataDirectory,'identity.key')),{ code:'ENOENT' })
    await assert.rejects(access(join(dataDirectory,'tls')),{ code:'ENOENT' })
  } finally { await Promise.all(stores.map(store => store.close())); await owned.cleanup() }
})
