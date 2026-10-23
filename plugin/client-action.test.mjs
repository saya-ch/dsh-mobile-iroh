import test from 'node:test'
import assert from 'node:assert/strict'
import { createLaunchAction,isLocalManager } from './client-action.mjs'
const document = { querySelector:() => null }
test('only local Desktop/Web settings expose the operator action',() => {
  assert.equal(isLocalManager({ protocol:'dsh-app:',hostname:'app' },document),true)
  assert.equal(isLocalManager({ protocol:'http:',hostname:'127.0.0.1' },document),true)
  assert.equal(isLocalManager({ protocol:'https:',hostname:'iroh.localhost' },document),false)
  assert.equal(isLocalManager({ protocol:'http:',hostname:'127.0.0.1' },{ querySelector:() => ({}) }),false)
  assert.equal(isLocalManager({ protocol:'dsh-app:',hostname:'evil' },document),false)
})
test('repeated clicks share one in-flight effect and keep state changes bounded',async () => {
  let resolve,calls = 0; const states = []
  const action = createLaunchAction({ onChange:state => states.push(state),send:() => { calls++; return new Promise(done => { resolve = done }) } })
  const first = action.run(); await action.run(); assert.equal(calls,1); assert.deepEqual(states,['busy'])
  resolve(); await first; assert.deepEqual(states,['busy','opened']); action.close()
})
test('unmount aborts pending work without updating the removed row',async () => {
  let resolve,signal; const states = []
  const action = createLaunchAction({ onChange:state => states.push(state),send:value => { signal = value; return new Promise(done => { resolve = done }) } })
  const first = action.run(); action.close(); assert.equal(signal.aborted,true); resolve(); await first
  assert.deepEqual(states,['busy']); await action.run(); assert.deepEqual(states,['busy'])
})
test('deadline surfaces an inline retryable error instead of indefinite busy state',async () => {
  const states = []
  const action = createLaunchAction({ timeoutMs:10,onChange:state => states.push(state),send:signal => new Promise((_,reject) => signal.addEventListener('abort',() => reject(new Error('timeout')),{ once:true })) })
  await action.run(); assert.deepEqual(states,['busy','error']); action.close()
})
