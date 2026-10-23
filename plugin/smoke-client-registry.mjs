import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkClientBundle } from './check-client-bundle.mjs'

const runtime = createRequire(process.env.DSH_MOBILE_MODULE)
const { Context } = await import(pathToFileURL(runtime.resolve('@deepseek-ai/cordis')).href)
const { ClientModuleRegistry } = await import(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-client-modules')).href)
const directory = resolve(process.argv[2] ?? '.')
const hostEntry = pathToFileURL(resolve(directory,'plugin/index.mjs')).href
const context = new Context()
try {
  context.baseUrl = pathToFileURL(directory).href+'/'
  context.provide('loader',{
    *entries() {
      yield { options:{ name:hostEntry },fiber:{},disabled:false,parent:{ tree:{ ctx:{ baseUrl:context.baseUrl } } } }
    },
  })
  const registry = new ClientModuleRegistry(context)
  assert.equal(registry.clientPath('dsh-mobile-iroh'),resolve(directory,'lib/client.js'))
  const row = registry.graph().entries.find(entry => entry.id === 'dsh-mobile-iroh')
  assert.ok(row)
  assert.equal(row.immediately,true)
  const response = await registry.fetchBundle(new Request(new URL(row.url,'http://127.0.0.1')))
  assert.equal(response.status,200)
  const result = checkClientBundle(await response.text())
  process.stdout.write(JSON.stringify({ registry:'public-DSH-0.2.1-rc.2',manifest:'exports/client',selectedFile:'lib/client.js',batch:'pass',...result })+'\n')
} finally { await context.fiber.dispose() }
