import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createOperatorServer } from './server.mjs'

/** Headless interaction/layout probe of the real operator assets with a private injected owner. */
export async function smokeOperatorUi({ runtimeModule, outputDirectory = resolve('artifacts/operator-ui') }) {
  const require = createRequire(runtimeModule)
  const { chromium } = require('playwright')
  const qrcode = require('qrcode')
  await mkdir(outputDirectory,{ recursive:true })
  let state = { enabled:false,state:'off',configured:false,localPort:9443,localOnly:false,tls:{ state:'valid',renewable:true,notAfter:Date.now()+86400000 } }
  let peers = [{ id:'b'.repeat(64),name:'📱'.repeat(64),online:true,paired_at:'unix:1780000000' }]
  let cancelCount = 0
  let forgotten = 0
  let expiry = 3000
  const owner = {
    status:() => state,
    configure:async (config) => { state = { ...state,configured:true,localPort:config.localPort,localOnly:config.localOnly }; assert.match(config.upstreamAuthenticatedUrl,/fixture-only/u) },
    start:async () => { state = { ...state,enabled:true,state:'ready',endpointId:'a'.repeat(64),origin:`https://${'a'.repeat(64)}.localhost:9443` } },
    stop:async () => { state = { ...state,enabled:false,state:'off' } },
    reconnect:async () => { state = { ...state,enabled:true,state:'ready' } },
    openPairing:async () => ({ descriptor:{ expiresAt:Date.now()+expiry },qrPayload:'fixture-only-never-a-real-credential' }),
    cancelPairing:async () => { cancelCount++ },
    listPeers:async () => peers,
    forgetPeer:async () => { forgotten++; peers = []; return peers },
    renewTls:async () => {},
  }
  const server = await createOperatorServer({ owner,renderQr:(payload) => qrcode.toBuffer(payload,{ type:'png',errorCorrectionLevel:'M' }) })
  let browser
  const errors = []
  let context
  try {
    browser = await chromium.launch({ headless:true })
    context = await browser.newContext({ viewport:{ width:1280,height:1000 },colorScheme:'light',locale:'en',permissions:['clipboard-read','clipboard-write'] })
    const page = await context.newPage()
    page.on('pageerror',() => errors.push('pageerror'))
    page.on('request',(request) => { assert.equal(new URL(request.url()).origin,server.origin,'operator UI must stay offline and same-origin') })
    await page.goto(server.launchUrl)
    await page.locator('#workspace').waitFor({ state:'visible' })
    assert.equal(new URL(page.url()).hash,'')
    assert.equal(await page.locator('#upstream').getAttribute('type'),'password')
    await page.locator('#save').click()
    assert.equal(await page.locator('#upstream').getAttribute('aria-invalid'),'true')
    assert.equal(await page.evaluate(() => document.activeElement.id),'upstream')
    assert.match(await page.locator('#upstreamError').innerText(),/127\.0\.0\.1/u)
    await page.screenshot({ path:resolve(outputDirectory,'light-desktop.png'),fullPage:true })
    await page.locator('#upstream').fill('http://127.0.0.1:9555/?token=fixture-only')
    await page.locator('#save').click()
    await page.waitForFunction(() => document.querySelector('#start').disabled === false)
    assert.equal(await page.locator('#upstream').inputValue(),'')
    await page.locator('#start').click()
    await page.waitForFunction(() => document.querySelector('#statusTitle').textContent === 'Ready to connect')
    assert.equal(await page.locator('#save').isDisabled(),true)
    await page.locator('#refreshPeers').click()
    await page.locator('.peer').waitFor()
    assert.equal(await page.locator('.peer strong').innerText(),'📱'.repeat(64))
    await page.locator('.peer button').click()
    assert.equal(await page.evaluate(() => document.activeElement.id),'confirmCancel')
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => document.activeElement.id),'confirmForget')
    await page.keyboard.press('Escape')
    assert.equal(forgotten,0)
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('danger')),true)
    await page.locator('.peer button').click()
    await page.locator('#confirmForget').click()
    await page.waitForFunction(() => document.querySelectorAll('.peer').length === 0)
    assert.equal(forgotten,1)
    await page.locator('#pair').click()
    await page.locator('#qrPanel').waitFor({ state:'visible' })
    assert.match(await page.locator('#qr').getAttribute('src'),/^data:image\/png;base64,/u)
    assert.equal(await page.locator('body').innerText().then((text) => text.includes('fixture-only-never-a-real-credential')),false)
    await page.locator('#copy').click()
    await page.waitForFunction(() => document.querySelector('#notice').textContent.startsWith('One-time pairing content copied'))
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()),'fixture-only-never-a-real-credential')
    await page.evaluate(() => navigator.clipboard.writeText(''))
    await page.locator('#cancelPairing').click()
    await page.locator('#qrPanel').waitFor({ state:'hidden' })
    assert.equal(await page.locator('#qr').getAttribute('src'),null)
    expiry = 1500
    await page.locator('#pair').click()
    await page.locator('#qrPanel').waitFor({ state:'visible' })
    await page.locator('#qrPanel').waitFor({ state:'hidden' })
    assert.equal(await page.locator('#qr').getAttribute('src'),null)
    expiry = 5000
    const closingPage = await context.newPage()
    await closingPage.goto(server.origin)
    await closingPage.locator('#workspace').waitFor({ state:'visible' })
    await closingPage.locator('#pair').click()
    await closingPage.locator('#qrPanel').waitFor({ state:'visible' })
    const beforeClose = cancelCount
    await closingPage.close()
    await page.waitForFunction(() => document.readyState === 'complete')
    const closeDeadline = Date.now()+3000
    while (cancelCount === beforeClose && Date.now() < closeDeadline) await new Promise((resolve) => setTimeout(resolve,10))
    assert.ok(cancelCount > beforeClose,'actual pagehide must request authenticated pairing cancellation')
    for (const theme of ['light','dark']) {
      await page.emulateMedia({ colorScheme:theme,reducedMotion:'reduce' })
      await page.setViewportSize({ width:375,height:812 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true)
      const smallTargets = await page.locator('button,select,input:not([type=checkbox])').evaluateAll((elements) => elements.filter((element) => !element.hidden && element.getClientRects().length && element.getBoundingClientRect().height < 44).map((element) => element.id))
      assert.deepEqual(smallTargets,[])
      await page.screenshot({ path:resolve(outputDirectory,`${theme}-375.png`),fullPage:true })
    }
    await page.locator('#language').selectOption('it')
    assert.match(await page.locator('h1').innerText(),/Collega/u)
    await page.locator('#language').selectOption('zh')
    assert.match(await page.locator('h1').innerText(),/手机/u)
    await page.setViewportSize({ width:812,height:375 })
    await page.evaluate(() => { document.documentElement.style.fontSize = '24px' })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true)
    await page.screenshot({ path:resolve(outputDirectory,'dark-landscape-large-text.png'),fullPage:true })
    await page.locator('#logout').click()
    await page.locator('#locked').waitFor({ state:'visible' })
    assert.equal(await page.locator('#qr').getAttribute('src'),null)
    assert.ok(cancelCount > 0)
    assert.deepEqual(errors,[])
    return { interactions:'pass',lightDark375:'pass',landscapeLargeText:'pass',keyboardConfirmation:'pass',screenshots:outputDirectory }
  } finally {
    const failures = []
    for (const close of [() => context?.close(),() => browser?.close(),() => server.close()]) {
      try { await close() } catch (error) { failures.push(error) }
    }
    if (failures.length) {
      const failure = new Error('operator_ui_cleanup_failed')
      failure.owner = { close:async () => { await context?.close(); await browser?.close(); await server.close() } }
      throw failure
    }
  }
}

if (process.argv[1] && import.meta.url === new URL(`file:///${resolve(process.argv[1]).replaceAll('\\','/')}`).href) {
  const runtimeModule = process.env.DSH_MOBILE_MODULE
  if (!runtimeModule) throw new Error('Set DSH_MOBILE_MODULE to the isolated public Mobile runtime module')
  try { console.log(JSON.stringify(await smokeOperatorUi({ runtimeModule }))) }
  catch { console.error('operator_ui_verification_failed'); process.exitCode = 1 }
}
