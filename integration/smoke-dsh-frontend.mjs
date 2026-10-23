/** Real DSH frontend over the Android transport crate; no user profile or model request. */
import assert from 'node:assert/strict'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createDshWebProfile, startDshWeb, redactDshOutput } from './dsh-web-fixture.mjs'
import { createIrohGatewayFactory } from './mobile-gateway-factory.mjs'
import { createExtensionHost } from './extension-host.mjs'
import { irohHostname, irohOrigin } from './origin-contract.mjs'
import { createSidecarFixtureRoot, firstPartyExecutable, resolveSidecarIdentity, startHostAndPhone, startPhone } from '../src/first-party-fixture.mjs'

const modulePath = process.env.DSH_MOBILE_MODULE
const dshBin = process.env.DSH_IROH_DSH_BIN
assert(isAbsolute(modulePath ?? '') && isAbsolute(dshBin ?? ''), 'Set absolute DSH_MOBILE_MODULE and DSH_IROH_DSH_BIN artifact paths')
const require = createRequire(modulePath)
const mobile = await import(pathToFileURL(modulePath).href)
const { generate } = require('selfsigned')
const { chromium } = require('playwright')
const { unzipSync } = require('fflate')
const mobileVersion = JSON.parse(await readFile(join(dirname(modulePath), '..', 'package.json'), 'utf8')).version
const dshVersion = JSON.parse(await readFile(join(dirname(dshBin), '..', 'package.json'), 'utf8')).version
const localPort = Number(process.env.IROH_LOCAL_PORT ?? 25443)
const phoneExecutable = fileURLToPath(new URL(`../target/debug/dsh-mobile-iroh-transport-sim${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url))
const owned = await createSidecarFixtureRoot('dsh-frontend')
let profile, dsh, backend, carrier, phone, browser, context, page, mux, passed, extensionHost, gatewayClosed = false
let prompts = 0, upstreamModelRequests = 0, modelSink, mainFailure, stage = 'owned profile installation'
const checks = [], cleanup = []
const failures = [], pageErrors = [], exits = []
const featureResponses = []

async function within(promise, message, timeoutMs = 60000) {
  let timer
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) })]) }
  finally { clearTimeout(timer) }
}

function workspaceObserver(page) {
  const baselines = [], waiters = new Set()
  const stats = { sockets: 0, closes: 0, frames: 0, workspaceOpens: 0 }
  page.on('websocket', socket => {
    if (new URL(socket.url()).pathname !== '/api/remote.mux') return
    stats.sockets++
    const streams = new Map()
    socket.on('framesent', frame => {
      let message
      try { message = JSON.parse(String(frame.payload)) } catch { return }
      if (message.type === 'open' && typeof message.streamId === 'string' && typeof message.endpoint === 'string') {
        streams.set(message.streamId, message.endpoint)
        if (message.endpoint === 'workspace/follow') stats.workspaceOpens++
      }
    })
    socket.on('framereceived', frame => {
      stats.frames++
      let message
      try { message = JSON.parse(String(frame.payload)) } catch { return }
      const value = message.value
      if (message.type !== 'item' || streams.get(message.streamId) !== 'workspace/follow'
        || value?.type !== 'baseline' || !Array.isArray(value.value?.items)
        || !Array.isArray(value.value.archivedSessionIds) || !Array.isArray(value.value.pinnedSessionIds)) return
      const baseline = { value: value.value, socket }
      baselines.push(baseline)
      for (const waiter of [...waiters]) if (baselines.length > waiter.after) { waiters.delete(waiter); waiter.resolve(baseline) }
    })
    socket.on('close', () => stats.closes++)
  })
  return {
    stats, get count() { return baselines.length },
    async next(after = 0) {
      if (baselines.length > after) return baselines.at(-1)
      let waiter
      const pending = new Promise(resolve => { waiter = { after, resolve }; waiters.add(waiter) })
      try { return await within(pending, 'Real DSH Workspace subscription did not deliver a baseline') }
      finally { waiters.delete(waiter) }
    },
  }
}

async function dismissOnboarding(page) {
  const dialog = page.locator('[role="dialog"][aria-modal="true"]').first()
  for (let step = 0; step < 3; step++) {
    try { await dialog.waitFor({ state: 'visible', timeout: 3000 }) } catch (error) {
      if (error.name !== 'TimeoutError' || await dialog.count() !== 0) throw error
    }
    if (await dialog.count() === 0) return
    const label = await dialog.getAttribute('aria-label')
    const choices = (await dialog.locator('button').allTextContents()).map(value => value.trim())
    let action
    if (/^(?:Get started|开始使用)$/u.test(label ?? '') && choices.includes('Sign in')) action = dialog.getByRole('button', { name: /^(?:Close|关闭)$/u })
    else if (/^(?:Add an API key to get started|添加一个 API Key 开始使用)$/u.test(label ?? '')) action = dialog.getByRole('button', { name: /^(?:Configure later|稍后配置)$/u })
    else if (/^(?:Internal Testing Notice|Preview Notice|内测声明|预览版说明)$/u.test(label ?? '') && choices.length === 1) action = dialog.getByRole('button', { name: /^(?:Continue|继续)$/u })
    else throw new Error('Unexpected real DSH onboarding dialog')
    assert.equal(await action.count(), 1)
    await action.click()
    await page.waitForFunction(previous => document.querySelector('[role="dialog"][aria-modal="true"]')?.getAttribute('aria-label') !== previous, label)
  }
}

try {
  modelSink = createServer((_request, response) => { upstreamModelRequests++; response.writeHead(418); response.end('No model execution in this fixture') })
  await new Promise((resolve, reject) => { modelSink.once('error', reject); modelSink.listen(0, '127.0.0.1', resolve) })
  profile = await createDshWebProfile({ dshBin, root: owned.directory, mobileModule: modulePath,
    extraPatches: [{ id: 'llm-deepseek', config: { apiKeyEnv: 'DSH_IROH_CATALOG_FIXTURE_KEY',
      baseUrl: `http://127.0.0.1:${modelSink.address().port}`, models: [
      { id: 'iroh-acceptance-one', name: 'Owned iroh model one', contextWindow: 128000, inputModalities: ['text'] },
      { id: 'iroh-acceptance-two', name: 'Owned iroh model two', contextWindow: 128000, inputModalities: ['text'] },
    ] } }] })
  console.log(JSON.stringify({ stage, dshVersion, mobileVersion, installedMobileVersion: profile.mobileVersion, installation: profile.installation }))
  await writeFile(join(profile.home, '.credentials.yaml'), JSON.stringify({ version: 1,
    refs: { DSH_IROH_CATALOG_FIXTURE_KEY: 'iroh-owned-fixture-not-a-real-api-key' } }) + '\n', { flag: 'wx', mode: 0o600 })
  stage = 'native QUIC and public Gateway setup'
  const dataDir = join(owned.directory, 'host')
  const endpointId = await resolveSidecarIdentity({ executable: firstPartyExecutable, dataDir })
  const hostname = irohHostname(endpointId), origin = irohOrigin(endpointId, localPort)
  const ca = await generate([{ name: 'commonName', value: 'Iroh real DSH acceptance CA' }], {
    keyType: 'ec', curve: 'P-256', algorithm: 'sha256',
    extensions: [{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true }],
  })
  const leaf = await generate([{ name: 'commonName', value: hostname }], {
    keyType: 'ec', curve: 'P-256', algorithm: 'sha256', ca: { cert: ca.cert, key: ca.private },
    extensions: [{ name: 'basicConstraints', cA: false }, { name: 'extKeyUsage', serverAuth: true }, { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] }],
  })
  const tls = { caFile: join(dataDir, 'frontend-ca.pem'), certFile: join(dataDir, 'frontend-leaf.pem'), keyFile: join(dataDir, 'frontend-key.pem') }
  await Promise.all([writeFile(tls.caFile, ca.cert, { flag: 'wx', mode: 0o600 }), writeFile(tls.certFile, leaf.cert, { flag: 'wx', mode: 0o600 }), writeFile(tls.keyFile, leaf.private, { flag: 'wx', mode: 0o600 })])
  dsh = await startDshWeb({ dshBin, root: owned.directory })
  extensionHost = await createExtensionHost({ mobile, modulePath, providers: [({ registerExtension }) => {
    registerExtension({ schemaVersion: 1, id: 'iroh-acceptance', name: 'Owned iroh acceptance', version: '1.0.0',
      actions: { status: { run: () => ({ transport: 'iroh', ownedFixture: true }) } },
      routes: [{ method: 'GET', path: '/status', handle: () => ({ contentType: 'application/json', body: JSON.stringify({ transport: 'iroh', ownedFixture: true }) }) }],
    })
  }] })
  backend = await createIrohGatewayFactory({ mobile, endpointId, localPort, backendHost: '::1', upstreamOrigin: dsh.origin,
    upstreamAuthenticatedUrl: dsh.authenticatedUrl, stateFile: join(dataDir, 'mobile-devices.json'), tls, extensionHost })()
  carrier = await startHostAndPhone({ proxyTarget: backend.proxyTarget, dataDir: owned.directory, expectedEndpointId: endpointId,
    proxyListen: `127.0.0.1:${localPort}`, phoneExecutable, phoneGracefulStdin: true })
  phone = carrier.phone
  const request = (path, { body, cookie, csrf } = {}) => new Promise((resolve, reject) => {
    const outgoing = httpsRequest({ hostname: '127.0.0.1', port: localPort, servername: hostname, ca: ca.cert, agent: false,
      path, method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(15000),
      headers: { host: new URL(origin).host, origin, accept: 'application/json', ...(cookie ? { cookie } : {}),
        ...(csrf ? { [mobile.CSRF_HEADER]: csrf } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }) },
    }, incoming => {
      const chunks = []; incoming.on('data', chunk => chunks.push(chunk)); incoming.once('error', reject)
      incoming.once('end', () => { const bytes = Buffer.concat(chunks); resolve({ status: incoming.statusCode, body: bytes.toString('utf8'), bytes, headers: incoming.headers }) })
    })
    outgoing.once('error', reject); outgoing.end(body)
  })
  assert.equal((await request('/')).status, 401)
  const pairing = await backend.gateway.access.openPairing()
  const paired = await request('/mobile-access/auth/native-pair', { body: JSON.stringify({ token: pairing.token, label: 'Owned real DSH iroh acceptance' }) })
  assert.equal(paired.status, 201, 'Native Mobile pairing over QUIC failed')
  const credential = JSON.parse(paired.body)
  const cookie = `${mobile.SESSION_COOKIE}=${credential.sessionToken}; ${mobile.CSRF_COOKIE}=${credential.csrfToken}`
  const caKey = new X509Certificate(leaf.cert).publicKey.export({ type: 'spki', format: 'der' })
  const spki = createHash('sha256').update(caKey).digest('base64')
  browser = await chromium.launch({ headless: true, args: [`--ignore-certificate-errors-spki-list=${spki}`,
    `--host-resolver-rules=MAP ${hostname} 127.0.0.1`, '--no-proxy-server'] })
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'en-US' })
  await context.addCookies([
    { name: mobile.SESSION_COOKIE, value: credential.sessionToken, domain: hostname, path: '/', secure: true, httpOnly: true, sameSite: 'Strict' },
    { name: mobile.CSRF_COOKIE, value: credential.csrfToken, domain: hostname, path: '/', secure: true, httpOnly: false, sameSite: 'Strict' },
  ])
  page = await context.newPage()
  page.on('pageerror', error => { if (pageErrors.length < 12) pageErrors.push(redactDshOutput(error.message)) })
  page.on('response', response => {
    const path = new URL(response.url()).pathname
    const receipt = { stage, path, method: response.request().method(), status: response.status(), at: new Date().toISOString() }
    if (response.status() >= 400 && failures.length < 30) failures.push(receipt)
    if (/modelCatalog|selectModel|session.export|client-modules|extensions\/manifest/u.test(path) && featureResponses.length < 60) featureResponses.push(receipt)
  })
  await page.route('**/api/session/prompt', async route => { prompts++; await route.abort('blockedbyclient') })
  await page.addInitScript(() => { window.__irohAcceptanceDocument = crypto.randomUUID() })
  mux = workspaceObserver(page)
  stage = 'real DSH frontend boot'
  const document = await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60000 })
  assert.equal(document.status(), 200)
  const browserRemoteAddress = await document.serverAddr()
  assert.equal(browserRemoteAddress?.ipAddress, '127.0.0.1', 'Browser bypassed the phone loopback transport')
  assert.equal(browserRemoteAddress.port, localPort)
  assert.equal(await page.evaluate(() => location.origin), origin)
  const initialMux = await mux.next()
  await page.locator('.dshm-drawer').waitFor({ state: 'attached', timeout: 60000 })
  await dismissOnboarding(page)
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors))
  checks.push('real DSH frontend, modules, native mobile layout and authenticated Workspace baseline over actual Android-core QUIC')
  stage = 'owned Workspace and Session creation'
  const workspacePath = join(owned.directory, 'workspace')
  await mkdir(workspacePath)
  const workspaceResult = await request('/api/workspace/create', { cookie, csrf: credential.csrfToken,
    body: JSON.stringify({ type: 'client-request', rpcId: 'iroh-acceptance-workspace', method: 'workspace/create', payload: { args: { request: { path: workspacePath } } } }) })
  assert.equal(workspaceResult.status, 200)
  const result = JSON.parse(workspaceResult.body)
  assert.equal(result.result?.ok, true)
  const workspaceId = result.result.value.workspace.workspaceId
  const drawer = page.locator('.dshm-drawer')
  await drawer.locator('button[data-dsh-mobile-toggle]').waitFor({ state: 'visible', timeout: 60000 })
  if (await drawer.getAttribute('data-open') !== 'true') await drawer.locator('button[data-dsh-mobile-toggle]').click()
  const sessionCreated = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/create' && response.request().method() === 'POST', { timeout: 60000 })
  try { await drawer.locator(`[role="treeitem"][data-row-key="workspace:${workspaceId}"]`).getByRole('button').last().click() }
  catch (error) { void sessionCreated.catch(() => {}); throw error }
  const sessionResult = await (await sessionCreated).json()
  assert.equal(sessionResult.result?.ok, true)
  const sessionId = sessionResult.result.value.sessionId
  await page.waitForFunction(id => document.querySelector('[data-conversation-session]')?.dataset.conversationSession === id, sessionId)
  if (await drawer.getAttribute('data-open') === 'true') await drawer.locator('button[data-dsh-mobile-toggle]').click()
  const editor = page.locator('[data-conversation-session] [data-composer-input][contenteditable="true"]').first()
  await editor.waitFor({ state: 'visible' })
  const draft = 'Owned iroh draft — preserve without sending'
  await editor.fill(draft)
  await editor.evaluate(node => { window.__irohAcceptanceEditor = node })
  const documentId = await page.evaluate(() => window.__irohAcceptanceDocument)
  stage = 'authenticated model catalog and actual model selection before revocation'
  const catalogResponse = await request('/api/session/modelCatalog', { cookie, csrf: credential.csrfToken,
    body: JSON.stringify({ type: 'client-request', rpcId: 'iroh-acceptance-catalog', method: 'session/modelCatalog', payload: { args: {} } }) })
  assert.equal(catalogResponse.status, 200, 'Authenticated model catalog failed before revocation')
  const catalog = JSON.parse(catalogResponse.body)
  assert.equal(catalog.result?.ok, true)
  assert(catalog.result.value.groups.some(group => group.models.some(model => model.id === 'iroh-acceptance-two')))
  const modelTrigger = page.getByRole('button', { name: /^Select model(?:, current .*)?$/u })
  await modelTrigger.click()
  const modelChoice = page.getByRole('menuitemradio', { name: 'Owned iroh model two', exact: true })
  await modelChoice.waitFor({ state: 'visible' })
  await modelChoice.click()
  await page.getByRole('button', { name: /^Select model, current Owned iroh model two/u }).waitFor({ state: 'visible' })
  assert.equal(await editor.innerText(), draft)
  checks.push('model catalog HTTP/RPC success and real model selection using declared fixture metadata and a non-secret dummy credential pointing only to a rejecting loopback sink')
  stage = 'real optional extension provider and authorization'
  assert.equal((await request('/mobile-access/extensions/manifest')).status, 401)
  const manifestResponse = await request('/mobile-access/extensions/manifest', { cookie })
  assert.equal(manifestResponse.status, 200)
  const extensionManifest = JSON.parse(manifestResponse.body)
  assert(extensionManifest.extensions.some(entry => entry.id === 'iroh-acceptance'))
  const extensionStatus = await request('/mobile-access/extensions/iroh-acceptance/routes/status', { cookie })
  assert.equal(extensionStatus.status, 200)
  assert.equal(JSON.parse(extensionStatus.body).ownedFixture, true)
  const extensionActionPath = '/mobile-access/extensions/iroh-acceptance/actions/status'
  assert.equal((await request(extensionActionPath, { cookie, body: '{}' })).status, 403)
  const extensionAction = await request(extensionActionPath, { cookie, csrf: credential.csrfToken, body: '{}' })
  assert.equal(extensionAction.status, 200)
  checks.push('nonempty public Mobile extension service, authenticated route/action and CSRF rejection through QUIC')
  stage = 'device module settings and required/dependency rejection'
  const moduleResponse = await request('/mobile-access/client-modules', { cookie })
  assert.equal(moduleResponse.status, 200)
  const moduleView = JSON.parse(moduleResponse.body)
  assert(moduleView.entries.length > 0)
  const requiredModule = moduleView.entries.find(entry => entry.required)
  assert(requiredModule)
  const writeModules = excludedClientModules => request('/mobile-access/client-modules', { cookie, csrf: credential.csrfToken, body: JSON.stringify({ excludedClientModules }) })
  assert.equal((await writeModules([requiredModule.id])).status, 409)
  const dependency = moduleView.entries.find(entry => !entry.required && moduleView.entries.some(consumer => consumer.id !== entry.id && consumer.dependencies.includes(entry.id)))
  assert(dependency, 'Real module catalog has no optional dependency rejection case')
  assert.equal((await writeModules([dependency.id])).status, 409)
  const optionalLeaf = moduleView.entries.find(entry => !entry.required && !moduleView.entries.some(consumer => consumer.dependencies.includes(entry.id)))
  assert(optionalLeaf, 'Real module catalog has no independent optional module')
  const savedModule = await writeModules([optionalLeaf.id])
  assert.equal(savedModule.status, 200)
  assert.equal(JSON.parse(savedModule.body).source, 'device')
  assert.deepEqual(JSON.parse((await request('/mobile-access/client-modules', { cookie })).body).excludedClientModules, [optionalLeaf.id])
  const resetModule = await request('/mobile-access/client-modules', { cookie, csrf: credential.csrfToken, body: JSON.stringify({ reset: true }) })
  assert.equal(resetModule.status, 200)
  assert.notEqual(JSON.parse(resetModule.body).source, 'device')
  assert.equal(await page.evaluate(() => window.__irohAcceptanceDocument), documentId)
  assert.equal(await editor.innerText(), draft)
  checks.push('this-device module save/read/reset, required and retained-consumer dependency conflicts, with current document/draft retained')
  stage = 'actual mounted settings and session log export'
  if (await drawer.getAttribute('data-open') !== 'true') await drawer.locator('button[data-dsh-mobile-toggle]').click()
  const directSettings = drawer.locator('button:has([data-slot="settings.trigger"])')
  const account = drawer.getByRole('button', { name: 'Account menu', exact: true })
  await directSettings.or(account).waitFor({ state: 'visible' })
  if (await directSettings.count() === 1) await directSettings.click()
  else { await account.click(); await page.getByRole('menuitem').filter({ has: page.getByText('Settings', { exact: true }) }).click() }
  await page.locator('.dsh-module-row').waitFor({ state: 'visible' })
  await page.locator('.dsh-module-row').getByRole('button', { name: 'Manage', exact: true }).click()
  const moduleDialog = page.locator('.dsh-module-dialog[open]')
  await moduleDialog.locator('[data-client-module-id]').first().waitFor({ state: 'attached' })
  assert.equal(await moduleDialog.locator(`[data-client-module-id="${requiredModule.id}"] input[type="checkbox"]`).isDisabled(), true)
  await moduleDialog.getByRole('button', { name: 'Close', exact: true }).click()
  await page.locator('[data-dsh-mobile-settings-header] button[class*="_close"]').click()
  if (await drawer.getAttribute('data-open') === 'true') await drawer.locator('button[data-dsh-mobile-toggle]').click()
  const exported = await request(`/api/session.export?sessionId=${encodeURIComponent(sessionId)}&includeDescendants=true`, { cookie })
  assert.equal(exported.status, 200)
  assert.match(String(exported.headers['content-type']), /(?:application\/zip|application\/octet-stream)/u)
  assert.equal(exported.bytes.subarray(0, 4).toString('hex'), '504b0304')
  const archive = unzipSync(exported.bytes)
  const logName = Object.keys(archive).find(name => !name.includes('/') && name.endsWith('.jsonl'))
  assert(logName, 'Session export ZIP omitted its root Session log')
  const log = Buffer.from(archive[logName]).toString('utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(log[0].type, 'session')
  assert.equal(log[0].id, sessionId)
  assert(log.some(event => event.type === 'model/selection' && event.data?.model === 'iroh-acceptance-two'), 'Downloaded Session log omitted the actual selected model')
  assert.equal(log.some(event => event.type === 'user/message'), false, 'The unsent draft was persisted as a sent prompt')
  assert.equal(await editor.innerText(), draft)
  checks.push('mounted General/module settings, required checkbox disabled, authenticated ZIP export with matching Session header/model-selection event and no sent draft; blank Session has no export header action')
  const before = mux.count
  const socketsBefore = mux.stats.sockets
  stage = 'actual Android transport crate stop and same-profile restart'
  assert.equal(initialMux.socket.isClosed(), false, 'The Workspace mux was already closed before stopping the Android transport')
  const disconnected = within(new Promise(resolve => {
    initialMux.socket.once('close', resolve)
  }), 'Stopping the Android transport did not close the real DSH mux')
  void disconnected.catch(() => {})
  const stopped = await phone.stop()
  exits.push({ process: 'transport-before-restart', ...stopped })
  assert.equal(stopped.exitCode, 0, 'Android transport did not close gracefully')
  assert.equal(stopped.signal, null)
  await disconnected
  phone = await startPhone({ executable: phoneExecutable, dataDir: carrier.phoneDataDir, endpointId,
    peerAddresses: carrier.peerAddresses, proxyListen: `127.0.0.1:${localPort}`, localOnly: true, gracefulStdin: true })
  const recovered = await mux.next(before)
  assert.notEqual(recovered.socket, initialMux.socket, 'DSH reused the stopped mux')
  assert(mux.stats.sockets > socketsBefore, 'DSH did not open a new real mux after transport restart')
  assert.equal(recovered.socket.isClosed(), false, 'Recovered DSH mux is already closed')
  assert(recovered.value.items.some(item => item.workspaceId === workspaceId), 'Recovered Workspace baseline missed the owned Workspace')
  assert.equal(await page.evaluate(() => window.__irohAcceptanceDocument), documentId)
  assert.equal(await editor.evaluate(node => node === window.__irohAcceptanceEditor), true)
  assert.equal(await editor.innerText(), draft)
  checks.push('owned Workspace/Session and unsent draft retain the actual document/editor across transport restart')
  stage = 'Mobile device revocation'
  await backend.gateway.access.revokeDevice(credential.deviceId)
  assert.equal((await request('/api/workspace/list', { cookie })).status, 401)
  assert.equal(prompts, 0)
  assert.equal(upstreamModelRequests, 0)
  assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors))
  assert.equal(failures.filter(failure => failure.status === 401 && failure.stage !== 'Mobile device revocation').length, 0, 'Unexpected browser authorization failure before deliberate revocation')
  checks.push('revoked Mobile device receives HTTP 401 through the restarted Android-core transport')
  passed = { status: 'passed', dshVersion, mobileVersion, installedMobileVersion: profile.mobileVersion, checks, mux: mux.stats,
    prompts, upstreamModelRequests, observedHttpFailures: failures, featureResponses, pageErrors, browserRemoteAddress, browserFixtureHostMapping: true,
    realDshFrontend: true, physicalAndroid: false, publicNetwork: false, injectedCertificateSpkiOnly: true }
} catch (error) {
  mainFailure = error
  console.error(JSON.stringify({ status: 'failed', stage, dshVersion, mobileVersion, checks, mux: mux?.stats, prompts, upstreamModelRequests, failures, featureResponses, pageErrors }))
  console.error(redactDshOutput(error.stack ?? error))
  if (page) {
    try { console.error(redactDshOutput(await page.locator('body').innerText({ timeout: 3000 }))) } catch { /* The failed page may already be unreachable. */ }
  }
  if (profile) console.error(profile.logs())
  if (dsh) console.error(dsh.logs())
} finally {
  for (const [process, action] of [['browser-context', () => context?.close()], ['browser', () => browser?.close()],
    ['transport', () => phone?.stop()], ['host-and-initial-transport', () => carrier?.close()],
    ['Gateway', async () => { await backend?.close(); gatewayClosed = true }],
    ['extensions', () => { if (!gatewayClosed) throw new Error('Retain extension host while Gateway close is unconfirmed'); return extensionHost?.close() }],
    ['DSH', () => dsh?.close()],
    ['rejecting-model-sink', () => new Promise((resolve, reject) => { if (!modelSink?.listening) resolve(); else modelSink.close(error => error ? reject(error) : resolve()) })]]) {
    try { const result = await action(); exits.push({ process, ...(result ?? {}), closed: true }) } catch (error) { cleanup.push(error) }
  }
  if (cleanup.length === 0 && !mainFailure?.preserveFixtureRoot) {
    try { await owned.cleanup() } catch (error) { cleanup.push(error) }
  }
  console.log(JSON.stringify({ cleanup: mainFailure?.preserveFixtureRoot ? 'process-close-unconfirmed-root-preserved' : cleanup.length === 0 ? 'complete' : 'failed',
    ...(mainFailure?.preserveFixtureRoot ? { preservedFixtureRoot: owned.directory } : {}), retainedUserProfiles: true, exits }))
  if (mainFailure || cleanup.length) throw new AggregateError([...(mainFailure ? [mainFailure] : []), ...cleanup], 'Real DSH frontend acceptance failed')
  console.log(JSON.stringify(passed))
}
