import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { join,resolve } from 'node:path'
import { parseOperatorArguments,launchOperator,runOperatorCli,openOperatorUrl } from './cli.mjs'

const modulePath = resolve('fixture/mobile/index.mjs'),executable = resolve('fixture/host.exe'),userHome = resolve('fixture/home')
const args = ['--mobile-module',modulePath,'--executable',executable,'--no-open']
const origin = 'http://127.0.0.1:35555',launchUrl = `${origin}/#${'a'.repeat(43)}`
const output = isTTY => ({ isTTY,text:'',write(value){ this.text += value } })
function dependencies(extra = {}) {
  const events = []
  return { events,...{
    stdout:output(true),loadMobile:async () => ({}),loadQr:() => ({ toBuffer:async () => Buffer.from('png') }),
    ownerFactory:() => ({ initialize:async () => { events.push('initialize') },close:async () => { events.push('owner-close') } }),
    serverFactory:async () => ({ origin,launchUrl,close:async () => { events.push('server-close') } }),openUrl:async () => { events.push('open') },
  },...extra }
}

test('CLI requires explicit absolute artifacts and a user-home private directory by default',() => {
  const parsed = parseOperatorArguments(args,{ userHome })
  assert.equal(parsed.modulePath,modulePath); assert.equal(parsed.dataDirectory,join(userHome,'.dsh-mobile-iroh')); assert.equal(parsed.open,false)
  for (const invalid of [[],['--mobile-module','relative'],[...args,'--no-open'],[...args,'--token','secret'],[...args,'--data-dir','relative']]) assert.throws(() => parseOperatorArguments(invalid))
})

test('bootstrap prints its one-time fragment only to trusted interactive stdout and never auto-starts transport',async () => {
  const d = dependencies(),options = parseOperatorArguments(args,{ userHome })
  const operator = await launchOperator(options,d)
  assert.equal(d.stdout.text,`DSH Mobile iroh operator: ${launchUrl}\n`)
  assert.deepEqual(d.events,['initialize'])
  await operator.close(); await operator.close()
  assert.deepEqual(d.events,['initialize','server-close','owner-close'])
  const noninteractive = dependencies({ stdout:output(false) })
  await assert.rejects(launchOperator(options,noninteractive),{ code:'operator_interactive_stdout_required' })
  assert.deepEqual(noninteractive.events,[])
})

test('default open uses the generated URL while redirected output contains no fragment',async () => {
  const d = dependencies({ stdout:output(false) })
  const operator = await launchOperator(parseOperatorArguments(args.slice(0,-1),{ userHome }),d)
  assert.equal(d.stdout.text,`DSH Mobile iroh operator: ${origin}\n`); assert.equal(d.events.includes('open'),true)
  await operator.close()
})

test('failed initialization closes its owner without exposing credential-like errors',async () => {
  let closed = false
  const d = dependencies({ ownerFactory:() => ({ initialize:async () => { throw new Error('token=SECRET_PATH') },close:async () => { closed = true } }) })
  await assert.rejects(launchOperator(parseOperatorArguments(args),d),error => { assert.equal(error.code,'operator_bootstrap_failed'); assert.doesNotMatch(error.message,/SECRET_PATH/u); return true })
  assert.equal(closed,true); assert.equal(d.stdout.text,'')
})

test('CLI signal shutdown closes server before owner and retries unconfirmed cleanup',async () => {
  const signals = new EventEmitter(),stderr = output(false),d = dependencies()
  let attempts = 0,ownerClosed = false
  d.serverFactory = async () => ({ origin,launchUrl,close:async () => { attempts++; if (attempts === 1) throw new Error('PRIVATE') } })
  d.ownerFactory = () => ({ initialize:async () => {},close:async () => { ownerClosed = true } })
  const running = runOperatorCli({ args,...d,events:signals,stderr })
  while (signals.listenerCount('SIGTERM') === 0) await new Promise(resolve => setImmediate(resolve))
  signals.emit('SIGTERM')
  while (!stderr.text) await new Promise(resolve => setImmediate(resolve))
  assert.equal(ownerClosed,false); assert.doesNotMatch(stderr.text,/PRIVATE/u)
  signals.emit('SIGINT'); await running
  assert.equal(ownerClosed,true); assert.equal(attempts,2); assert.equal(signals.listenerCount('SIGTERM'),0)
})

test('browser launcher rejects arbitrary URLs and uses no shell for a generated local URL',async () => {
  await assert.rejects(openOperatorUrl('https://evil.invalid'),{ code:'operator_invalid_launch_url' })
  let call
  const opening = openOperatorUrl(launchUrl,{ platform:'win32',systemRoot:resolve('Windows'),spawnImpl:(file,args,options) => {
    call = { file,args,options }; const child = new EventEmitter(); queueMicrotask(() => child.emit('close',0,null)); return child
  } })
  await opening
  assert.equal(call.options.shell,false); assert.equal(call.options.windowsHide,true); assert.equal(call.args[1],launchUrl)
})

test('browser helper deadlines retain an unclosed child for explicit retry',async () => {
  const child = new EventEmitter(),kills = []
  child.kill = signal => { kills.push(signal ?? 'SIGTERM'); return true }
  let failure
  await assert.rejects(openOperatorUrl(launchUrl,{ spawnImpl:() => child,timeoutMs:5,stopTimeoutMs:5 }),error => { failure = error; return error.code === 'operator_browser_helper_not_closed' })
  assert.deepEqual(kills,['SIGTERM','SIGKILL'])
  const closing = failure.browserOwner.close()
  child.emit('close',null,'SIGTERM'); await closing
})

test('bootstrap cleanup failure retains a close capability and marks fixture roots for preservation',async () => {
  let canClose = false,closed = false,retained
  const d = dependencies({ ownerFactory:() => ({ initialize:async () => { throw new Error('PRIVATE') },close:async () => { if (!canClose) throw new Error('PRIVATE'); closed = true } }) })
  await assert.rejects(launchOperator(parseOperatorArguments(args),d),error => {
    retained = error
    assert.equal(error.code,'operator_bootstrap_cleanup_failed'); assert.equal(error.preserveFixtureRoot,true)
    assert.doesNotMatch(error.message,/PRIVATE/u); assert.equal(typeof error.owner.close,'function'); return true
  })
  assert.equal(closed,false)
  canClose = true; await retained.owner.close(); assert.equal(closed,true)
})
