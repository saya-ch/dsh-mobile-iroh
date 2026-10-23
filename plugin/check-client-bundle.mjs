import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

/** Validate actual DSH factory registration without invoking DOM effects at load time. */
export function checkClientBundle(source) {
  const registrations = []
  runInNewContext(source,{ window:{ __ModuleLoader__:{ load:definition => registrations.push(definition) } } },{ timeout:1000 })
  assert.equal(registrations.length,1)
  assert.equal(registrations[0].id,'dsh-mobile-iroh')
  assert.equal(typeof registrations[0].factory,'function')
  const imports = []
  const client = registrations[0].factory(id => { imports.push(id); if (id !== 'react') throw new Error('unexpected_client_dependency'); return {} })
  assert.deepEqual(imports,['react'])
  assert.equal(typeof client.apply,'function')
  assert.deepEqual(Array.from(client.inject),['slots'])
  return { module:'dsh-mobile-iroh',external:imports,registration:'pass' }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = checkClientBundle(await readFile(new URL('../lib/client.js',import.meta.url),'utf8'))
  process.stdout.write(JSON.stringify(result)+'\n')
}
