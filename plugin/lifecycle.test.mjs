import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mountPlugin } from './index.mjs'
import { LAUNCH_PATH } from './security.mjs'
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise,resolve } }

test('route withdrawal precedes cancellation and disposal waits for real launch completion',async t => {
  let route,dispose,origin,closed = false,abortObserved = false
  const entered = deferred(),gate = deferred(),events = []
  const server = createServer((req,res) => { if (route) void route.handler(req,res); else { res.writeHead(404); res.end() } })
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  t.after(async () => { gate.resolve(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const runtime = { origin,initialize:async () => {},launch:async ({ signal }) => { signal.addEventListener('abort',() => { abortObserved = true },{ once:true }); entered.resolve(); await gate.promise; if (signal.aborted) throw new Error('cancelled') },
    close:async () => { events.push('runtime-close'); await gate.promise; closed = true } }
  const ctx = { connection:{ requestRejection:() => undefined },webServer:{ register:value => { route = value; return () => { route = undefined; events.push('unregister') } } },effect:factory => { dispose = factory() },logger:() => ({ warn:() => {} }) }
  await mountPlugin(ctx,runtime)
  const response = fetch(origin+LAUNCH_PATH,{ method:'POST',headers:{ Origin:origin,'Content-Type':'application/json','X-DSH-Iroh-Admin':'same-origin-json' },body:'{"version":1}' })
  await entered.promise
  let disposed = false; const disposal = dispose().then(() => { disposed = true })
  await tick(); assert.equal(abortObserved,true); assert.equal(disposed,false); assert.equal(closed,false)
  assert.deepEqual(events,['unregister','runtime-close'])
  assert.equal((await fetch(origin+LAUNCH_PATH)).status,404)
  gate.resolve(); await disposal; assert.equal((await response).status,503); assert.equal(closed,true)
})

test('startup failure is contained and only a redacted fixed diagnostic reaches DSH logging',async () => {
  let dispose,warning
  const ctx = { connection:{},webServer:{ register:() => () => {} },effect:factory => { dispose = factory() },logger:() => ({ warn:value => { warning = value } }) }
  await mountPlugin(ctx,{ origin:'http://127.0.0.1:9555',initialize:async () => { throw new Error('SECRET_TOKEN') },close:async () => {} })
  await tick(); assert.match(warning,/iroh_initialization_failed/u); assert.doesNotMatch(warning,/SECRET_TOKEN/u)
  await dispose()
})
