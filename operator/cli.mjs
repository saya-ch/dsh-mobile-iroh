import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { isAbsolute,join,resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createOperatorOwner } from '../integration/operator-owner.mjs'
import { createOperatorServer } from './server.mjs'

const fault = code => Object.assign(new Error(code),{ code })

/** Parse explicit artifact locations without guessing a DSH profile or installed package. */
export function parseOperatorArguments(args,{ userHome = homedir() } = {}) {
  const options = { dataDirectory:join(userHome,'.dsh-mobile-iroh'),open:true }
  const fields = new Map([['--mobile-module','modulePath'],['--executable','executable'],['--data-dir','dataDirectory'],['--extensions-dir','localDirectory']])
  const used = new Set()
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (used.has(flag)) throw fault('operator_duplicate_argument')
    used.add(flag)
    if (flag === '--no-open') { options.open = false; continue }
    const field = fields.get(flag),value = args[++index]
    if (!field || !value || !isAbsolute(value) || value.includes('\0')) throw fault('operator_invalid_arguments')
    options[field] = resolve(value)
  }
  if (!options.modulePath || !options.executable) throw fault('operator_explicit_artifacts_required')
  return Object.freeze(options)
}

/** Open only the generated numeric-loopback URL, with no shell command interpolation. */
export async function openOperatorUrl(url,{ platform = process.platform,spawnImpl = spawn,systemRoot = process.env.SystemRoot ?? 'C:\\Windows',timeoutMs = 10000,stopTimeoutMs = 2000 } = {}) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/#[-_A-Za-z0-9]{43}$/u.test(url)) throw fault('operator_invalid_launch_url')
  const [file,args] = platform === 'win32' ? [join(systemRoot,'System32','rundll32.exe'),['url.dll,FileProtocolHandler',url]]
    : platform === 'darwin' ? ['/usr/bin/open',[url]] : ['xdg-open',[url]]
  let child
  try { child = spawnImpl(file,args,{ windowsHide:true,stdio:'ignore',shell:false }) } catch { throw fault('operator_browser_open_failed') }
  let closed = false,failed = false,closeTask
  const actualClose = new Promise(resolve => {
    child.once('error',() => { failed = true })
    child.once('close',(code,signal) => { closed = true; resolve({ code,signal }) })
  })
  const wait = async duration => {
    let timer
    try { return await Promise.race([actualClose,new Promise(resolve => { timer = setTimeout(() => resolve(undefined),duration) })]) }
    finally { clearTimeout(timer) }
  }
  const close = () => {
    if (closeTask) return closeTask
    closeTask = (async () => {
      if (closed) return
      try { child.kill() } catch { /* Only actual close releases the helper. */ }
      if (await wait(stopTimeoutMs)) return
      try { child.kill('SIGKILL') } catch { /* Failed helpers remain owned. */ }
      if (!await wait(stopTimeoutMs)) throw fault('operator_browser_helper_not_closed')
    })().catch(error => { closeTask = undefined; throw error })
    return closeTask
  }
  const result = await wait(timeoutMs)
  if (!result || failed || result.code !== 0 || result.signal !== null) {
    try { await close() } catch {
      const error = fault('operator_browser_helper_not_closed'); error.browserOwner = Object.freeze({ close }); throw error
    }
    throw fault('operator_browser_open_failed')
  }
}

/**
 * Bootstrap the real native/Host/Gateway owner and local UI. The caller owns
 * close; a failed cleanup retains its owner on the fixed-code error for retry.
 */
export async function launchOperator(options,{ loadMobile = modulePath => import(pathToFileURL(modulePath).href),ownerFactory = createOperatorOwner,
  serverFactory = createOperatorServer,openUrl = openOperatorUrl,stdout = process.stdout,loadQr = modulePath => createRequire(modulePath)('qrcode') } = {}) {
  if (!options.open && stdout.isTTY !== true) throw fault('operator_interactive_stdout_required')
  let owner,server,closeTask,browserOwner
  const close = () => {
    if (closeTask) return closeTask
    closeTask = (async () => { await browserOwner?.close(); await server?.close(); await owner?.close() })().catch(() => { closeTask = undefined; throw fault('operator_cleanup_failed') })
    return closeTask
  }
  try {
    const mobile = await loadMobile(options.modulePath)
    owner = ownerFactory({ mobile,...options })
    await owner.initialize()
    const qrcode = loadQr(options.modulePath)
    server = await serverFactory({ owner,renderQr:payload => qrcode.toBuffer(payload,{ type:'png',errorCorrectionLevel:'M' }) })
    // Only an explicit interactive output receives the one-time fragment.
    // Structured diagnostics and redirected logs receive no launch secret.
    if (stdout.isTTY === true) stdout.write(`DSH Mobile iroh operator: ${server.launchUrl}\n`)
    else stdout.write(`DSH Mobile iroh operator: ${server.origin}\n`)
    if (options.open) await openUrl(server.launchUrl)
    return Object.freeze({ owner,origin:server.origin,launchUrl:server.launchUrl,close })
  } catch (cause) {
    browserOwner = cause?.browserOwner
    try { await close() } catch {
      const error = fault('operator_bootstrap_cleanup_failed'); error.owner = Object.freeze({ close }); error.preserveFixtureRoot = true; throw error
    }
    throw fault('operator_bootstrap_failed')
  }
}

/** Await Ctrl-C/SIGTERM and retry failed cleanup on a later explicit signal. */
export async function runOperatorCli({ args = process.argv.slice(2),events = process,stdout = process.stdout,stderr = process.stderr,...dependencies } = {}) {
  const options = parseOperatorArguments(args)
  let operator
  try { operator = await launchOperator(options,{ stdout,...dependencies }) }
  catch (error) {
    if (!error.owner) throw error
    stderr.write('operator_bootstrap_cleanup_failed; retry Ctrl-C/SIGTERM after resolving the local failure\n')
    await waitForShutdown(error.owner,events,stderr)
    throw fault('operator_bootstrap_failed')
  }
  await waitForShutdown(operator,events,stderr)
}

async function waitForShutdown(operator,events,stderr) {
  await new Promise(resolve => {
    let closing = false
    const stop = () => {
      if (closing) return
      closing = true
      void operator.close().then(() => { events.removeListener('SIGINT',stop); events.removeListener('SIGTERM',stop); resolve() },() => {
        closing = false; stderr.write('operator_cleanup_failed; retry Ctrl-C/SIGTERM after resolving the local failure\n')
      })
    }
    events.on('SIGINT',stop); events.on('SIGTERM',stop)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await runOperatorCli() }
  catch (error) { process.stderr.write(`${/^operator_[a-z_]+$/u.test(error?.code ?? '') ? error.code : 'operator_bootstrap_failed'}\n`); process.exitCode = 1 }
}
