/** Real CLI bootstrap, operator GUI, native TLS/config, public DSH and Android-core local QUIC. */
import assert from 'node:assert/strict'
import { createHash,X509Certificate } from 'node:crypto'
import { mkdir,readFile } from 'node:fs/promises'
import { request as requestHttps } from 'node:https'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { dirname,isAbsolute,join,resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchOperator } from './cli.mjs'
import { createDshWebProfile,startDshWeb } from '../integration/dsh-web-fixture.mjs'
import { createSidecarFixtureRoot,firstPartyExecutable,startPhone } from '../src/first-party-fixture.mjs'
import { SidecarController } from '../src/sidecar-controller.mjs'
import { irohHostname } from '../integration/origin-contract.mjs'

const modulePath = process.env.DSH_MOBILE_MODULE,dshBin = process.env.DSH_IROH_DSH_BIN
assert(isAbsolute(modulePath ?? '') && isAbsolute(dshBin ?? ''),'Set explicit public Mobile and DSH artifact paths')
const require = createRequire(modulePath),{ chromium } = require('playwright')
const mobile = await import(pathToFileURL(modulePath).href)
const mobileVersion = JSON.parse(await readFile(join(dirname(modulePath),'..','package.json'),'utf8')).version
const dshVersion = JSON.parse(await readFile(join(dirname(dshBin),'..','package.json'),'utf8')).version
const owned = await createSidecarFixtureRoot('operator-runtime'),dataDirectory = join(owned.directory,'host')
const screenshots = resolve('artifacts/operator-real-ui')
await mkdir(screenshots,{ recursive:true })
let profile,dsh,operator,phone,browser,context,phoneBrowser,phoneContext,page,sidecar,mainFailure
let stage = 'owned-profile',prompts = 0
const checks = [],pageErrors = [],cleanupErrors = []
async function bounded(promise,message,timeoutMs = 15000) {
  let timer
  try { return await Promise.race([promise,new Promise((_,reject) => { timer = setTimeout(() => reject(new Error(message)),timeoutMs) })]) }
  finally { clearTimeout(timer) }
}
try {
  profile = await createDshWebProfile({ dshBin,mobileModule:modulePath,root:owned.directory })
  dsh = await startDshWeb({ dshBin,root:owned.directory })
  const reservation = createServer()
  await new Promise((resolve,reject) => { reservation.once('error',reject); reservation.listen(0,'::1',resolve) })
  const localPort = reservation.address().port
  await new Promise((resolve,reject) => reservation.close(error => error ? reject(error) : resolve()))
  const options = { modulePath,executable:firstPartyExecutable,dataDirectory,open:false,backendHost:'::1',sidecarFactory:options => { sidecar = new SidecarController(options); return sidecar } }
  stage = 'real-cli-bootstrap'
  operator = await launchOperator(options,{ stdout:{ isTTY:true,write() {} } })
  assert.equal(operator.owner.status().configured,false)
  browser = await chromium.launch({ headless:true })
  context = await browser.newContext({ viewport:{ width:1280,height:1000 },locale:'en-US',permissions:['clipboard-read','clipboard-write'] })
  page = await context.newPage()
  page.on('pageerror',() => pageErrors.push('operator-page-error'))
  await page.goto(operator.launchUrl)
  await page.locator('#workspace').waitFor({ state:'visible' })
  assert.equal(new URL(page.url()).hash,'')
  stage = 'real-configuration-and-start'
  await page.locator('#upstream').fill(dsh.authenticatedUrl)
  await page.locator('#port').fill(String(localPort))
  await page.locator('#localOnly').check()
  await page.locator('#save').click()
  await page.waitForFunction(() => document.querySelector('#start').disabled === false)
  assert.equal(await page.locator('#upstream').inputValue(),'')
  await page.locator('#start').click()
  await page.waitForFunction(() => document.querySelector('#statusTitle').textContent === 'Ready to connect',null,{ timeout:30000 })
  const safeStatus = operator.owner.status()
  assert.equal(safeStatus.tls.state,'valid'); assert.equal(safeStatus.localPort,localPort)
  assert.doesNotMatch(JSON.stringify(safeStatus),/token=|keyFile|dataDirectory|Authenticated/u)
  const savedConfiguration = await readFile(join(dataDirectory,'operator-config.json'),'utf8')
  assert.deepEqual(JSON.parse(savedConfiguration),{ version:1,upstreamOrigin:dsh.origin,localPort,localOnly:true })
  assert.equal(savedConfiguration.includes(new URL(dsh.authenticatedUrl).searchParams.get('token')),false)
  checks.push('real GUI config/start through NativeConfigStore, NativePreferenceStore, NativeTlsManager, public extension service and HostSession')
  for (const [theme,width,height] of [['light',1280,1000],['light',375,812],['dark',375,812]]) {
    await page.emulateMedia({ colorScheme:theme,reducedMotion:'reduce' }); await page.setViewportSize({ width,height })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true)
    await page.screenshot({ path:join(screenshots,`${theme}-${width}.png`),fullPage:true })
  }
  await page.setViewportSize({ width:1280,height:1000 })
  const copyDescriptor = async () => {
    stage = 'operator-qr-generation'
    const generated = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/pairing' && response.request().method() === 'POST')
    await page.locator('#pair').click(); assert.equal((await generated).status(),200,'operator QR generation failed')
    await page.locator('#qrPanel').waitFor({ state:'visible' })
    const copied = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/pairing/copy')
    await page.locator('#copy').click(); assert.equal((await copied).status(),200)
    await page.waitForFunction(() => document.querySelector('#notice').textContent.startsWith('One-time pairing content copied'))
    const descriptor = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))
    await page.evaluate(() => navigator.clipboard.writeText(''))
    return descriptor
  }
  stage = 'real-pairing-before-token-consumption'
  const oldDescriptor = await copyDescriptor()
  stage = 'real-transport-start'
  const ready = sidecar.events.find(event => event.type === 'ready')
  assert(ready)
  const phoneExecutable = resolve(`target/debug/dsh-mobile-iroh-transport-sim${process.platform === 'win32' ? '.exe' : ''}`)
  phone = await startPhone({ executable:phoneExecutable,dataDir:join(owned.directory,'phone'),endpointId:oldDescriptor.endpointId,
    peerAddresses:ready.direct_addresses,code:oldDescriptor.irohCode,proxyListen:`127.0.0.1:${localPort}`,localOnly:true,gracefulStdin:true })
  const ca = await readFile(join(dataDirectory,'tls','ca.pem'),'utf8')
  const hostname = irohHostname(oldDescriptor.endpointId)
  const request = (path,{ body,cookie } = {}) => new Promise((resolve,reject) => {
    const outgoing = requestHttps({ hostname:'127.0.0.1',port:localPort,servername:hostname,ca,agent:false,path,signal:AbortSignal.timeout(15000),
      method:body === undefined ? 'GET' : 'POST',headers:{ host:new URL(oldDescriptor.origin).host,origin:oldDescriptor.origin,
        ...(cookie ? { cookie } : {}),...(body === undefined ? {} : { 'content-type':'application/json','content-length':Buffer.byteLength(body) }) } },response => {
      const chunks = []; response.on('data',chunk => chunks.push(chunk)); response.once('error',reject)
      response.once('end',() => resolve({ status:response.statusCode,text:Buffer.concat(chunks).toString('utf8') }))
    })
    outgoing.once('error',reject); outgoing.end(body)
  })
  stage = 'gateway-unauthorized-control'
  assert.equal((await request('/api/workspace/list')).status,401)
  stage = 'cancel-old-unconsumed-gateway-token'
  const cancellation = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/pairing/cancel')
  await page.locator('#cancelPairing').click(); assert.equal((await cancellation).status(),200)
  const oldTokenResult = await request('/mobile-access/auth/native-pair',{ body:JSON.stringify({ token:oldDescriptor.gatewayToken,label:'Owned operator rejected old QR' }) })
  assert.ok([401,403].includes(oldTokenResult.status),'Unconsumed old gateway pairing token survived explicit cancellation')
  assert.equal(phone.exited,false,'Pairing cancellation must not remove an already-paired transport peer')
  const descriptor = await copyDescriptor()
  stage = 'fresh-gateway-token-acceptance'
  const paired = await request('/mobile-access/auth/native-pair',{ body:JSON.stringify({ token:descriptor.gatewayToken,label:'Owned operator real acceptance' }) })
  assert.equal(paired.status,201)
  const credential = JSON.parse(paired.text)
  const cookie = `${mobile.SESSION_COOKIE}=${credential.sessionToken}; ${mobile.CSRF_COOKIE}=${credential.csrfToken}`
  assert.equal((await request('/',{ cookie })).status,200)
  const extensions = await request('/mobile-access/extensions/manifest',{ cookie })
  assert.equal(extensions.status,200); assert.ok(Array.isArray(JSON.parse(extensions.text).extensions))
  checks.push('GUI-generated QR, actual Android-core transport pairing, cancellation rejects an unconsumed old gateway token without disconnecting the transport peer, fresh QR accepts Mobile pairing')
  stage = 'real-dsh-phone-frontend'
  const leafBefore = new X509Certificate(await readFile(join(dataDirectory,'tls','server.pem')))
  const spki = createHash('sha256').update(leafBefore.publicKey.export({ type:'spki',format:'der' })).digest('base64')
  phoneBrowser = await chromium.launch({ headless:true,args:[`--ignore-certificate-errors-spki-list=${spki}`,`--host-resolver-rules=MAP ${hostname} 127.0.0.1`,'--no-proxy-server'] })
  phoneContext = await phoneBrowser.newContext({ viewport:{ width:390,height:844 },isMobile:true,hasTouch:true,locale:'en-US' })
  await phoneContext.addCookies([
    { name:mobile.SESSION_COOKIE,value:credential.sessionToken,domain:hostname,path:'/',secure:true,httpOnly:true,sameSite:'Strict' },
    { name:mobile.CSRF_COOKIE,value:credential.csrfToken,domain:hostname,path:'/',secure:true,httpOnly:false,sameSite:'Strict' },
  ])
  const phonePage = await phoneContext.newPage()
  let baselines = 0,muxClosed = false
  phonePage.on('websocket',socket => {
    if (new URL(socket.url()).pathname !== '/api/remote.mux') return
    const streams = new Map()
    socket.on('framesent',frame => { try { const value = JSON.parse(String(frame.payload)); if (value.type === 'open') streams.set(value.streamId,value.endpoint) } catch { /* Non-JSON frames carry no baseline. */ } })
    socket.on('framereceived',frame => { try { const value = JSON.parse(String(frame.payload)); if (value.type === 'item' && streams.get(value.streamId) === 'workspace/follow' && value.value?.type === 'baseline') baselines++ } catch { /* Only the selected baseline is inspected. */ } })
    socket.on('close',() => { muxClosed = true })
  })
  phonePage.on('pageerror',() => pageErrors.push('phone-frontend-page-error'))
  await phonePage.route('**/api/session/prompt',async route => { prompts++; await route.abort('blockedbyclient') })
  const document = await phonePage.goto(descriptor.origin,{ waitUntil:'domcontentloaded',timeout:60000 })
  assert.equal(document.status(),200)
  const remote = await document.serverAddr(); assert.equal(remote.ipAddress,'127.0.0.1'); assert.equal(remote.port,localPort)
  await phonePage.locator('.dshm-drawer').waitFor({ state:'attached',timeout:60000 })
  await bounded((async () => { while (baselines === 0) await new Promise(resolve => setTimeout(resolve,20)) })(),'Real DSH Workspace baseline missing',60000)
  assert.equal(prompts,0)
  checks.push('real public DSH frontend and Workspace mux baseline through the actual phone bridge; socket path asserted, no model prompt')
  stage = 'live-native-leaf-renewal'
  const caBefore = new X509Certificate(ca).fingerprint256
  const renewal = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/tls/renew')
  await page.locator('#renewTls').click(); assert.equal((await renewal).status(),200)
  const leafAfter = new X509Certificate(await readFile(join(dataDirectory,'tls','server.pem')))
  assert.notEqual(leafAfter.fingerprint256,leafBefore.fingerprint256)
  assert.equal(new X509Certificate(await readFile(join(dataDirectory,'tls','ca.pem'))).fingerprint256,caBefore)
  assert.equal((await request('/',{ cookie })).status,200)
  assert.equal(muxClosed,false)
  checks.push('GUI renews a real native leaf under the stable CA and refreshes the active Gateway without closing its existing authenticated mux')
  stage = 'real-peer-revocation-and-stop'
  const refreshPeers = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/peers')
  await page.locator('#refreshPeers').click(); assert.equal((await refreshPeers).status(),200)
  await page.locator('.peer button').click(); await page.locator('#confirmForget').click()
  await page.waitForFunction(() => document.querySelectorAll('.peer').length === 0)
  await bounded(phone.closed,'Revoked real transport did not close')
  const stopping = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/stop')
  await page.locator('#stop').click(); assert.equal((await stopping).status(),200)
  assert.equal(JSON.parse(await readFile(join(dataDirectory,'operator-state.json'),'utf8')).enabled,false)
  await operator.close(); operator = undefined
  stage = 'fresh-bootstrap-restores-safe-settings-only'
  operator = await launchOperator(options,{ stdout:{ isTTY:true,write() {} } })
  assert.equal(operator.owner.status().localPort,localPort); assert.equal(operator.owner.status().localOnly,true); assert.equal(operator.owner.status().configured,false)
  assert.equal(operator.owner.status().enabled,false)
  checks.push('real GUI peer confirmation closes transport; explicit stop disables durably; fresh bootstrap retains custom port/local-test policy but never persists upstream authorization')
  assert.deepEqual(pageErrors,[])
  console.log(JSON.stringify({ status:'passed',dshVersion,mobileVersion,installedMobileVersion:profile.mobileVersion,checks,prompts,realNativeTLS:true,realOperatorOwner:true,realCliBootstrap:true,realDshFrontend:true,androidCoreLocalQuic:true,physicalAndroid:false,publicNetwork:false,screenshots }))
} catch (error) {
  mainFailure = error
  console.error(JSON.stringify({ status:'failed',stage,checks,errorType:error?.name ?? 'Error',errorCode:/^[a-z_]+$/u.test(error?.code ?? '') ? error.code : undefined,
    actual:typeof error?.actual === 'number' ? error.actual : undefined,expected:typeof error?.expected === 'number' ? error.expected : undefined,
    frames:String(error?.stack ?? '').split('\n').filter(line => line.trimStart().startsWith('at ')).slice(0,4) }))
} finally {
  for (const action of [() => phoneContext?.close(),() => phoneBrowser?.close(),() => context?.close(),() => browser?.close(),() => phone?.stop(),() => operator?.close(),() => mainFailure?.owner?.close(),() => dsh?.close()]) {
    try { await action() } catch (error) { cleanupErrors.push(error) }
  }
  if (!cleanupErrors.length && !mainFailure?.preserveFixtureRoot) {
    try { await owned.cleanup() } catch (error) { cleanupErrors.push(error) }
  }
  const retained = cleanupErrors.length > 0 || mainFailure?.preserveFixtureRoot === true
  console.log(JSON.stringify({ cleanup:retained ? 'retained' : 'complete',...(retained ? { preservedFixtureRoot:owned.directory } : {}),physicalAndroid:false,publicNetwork:false }))
  if (mainFailure || cleanupErrors.length) throw new Error('operator_runtime_acceptance_failed')
}
