import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createOperatorServer } from '../operator/server.mjs'

const require = createRequire(process.env.DSH_MOBILE_MODULE)
const { chromium } = require('playwright')
let state = { enabled:false,state:'off',configured:true,managedHost:true,localPort:9443,localOnly:false },saved
const owner = {
  managedHost:true,status:() => state,configure:async value => { saved = value; state = { ...state,...value } },
  start:async () => { state = { ...state,enabled:true,state:'ready' } },stop:async () => { state = { ...state,enabled:false,state:'off' } },
  reconnect:async () => {},openPairing:async () => {},listPeers:async () => [],forgetPeer:async () => [],renewTls:async () => {},cancelPairing:async () => {},
}
const server = await createOperatorServer({ owner,renderQr:async () => Buffer.from('unused') })
let browser
try {
  browser = await chromium.launch({ headless:true })
  const context = await browser.newContext({ viewport:{ width:1100,height:850 },locale:'zh-CN' })
  const page = await context.newPage(),errors = []
  page.on('pageerror',error => errors.push(error.message))
  await page.goto(server.launchUrl); await page.locator('#workspace').waitFor({ state:'visible' })
  assert.equal(await page.locator('#upstreamFields').isVisible(),false)
  assert.equal(await page.locator('#upstream').isDisabled(),true)
  assert.equal(await page.locator('#start').isEnabled(),true)
  assert.match(await page.locator('#configHelp').innerText(),/无需复制/u)
  await page.locator('#port').fill('9444'); await page.locator('#save').click()
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('连接设置已保存'))
  assert.deepEqual(saved,{ version:1,localPort:9444,localOnly:false })
  for (const language of ['en','it','zh']) {
    await page.locator('#language').selectOption(language)
    assert.equal(await page.locator('#upstreamFields').isVisible(),false)
  }
  await page.locator('#start').click(); await page.waitForFunction(() => document.querySelector('#statusTitle').textContent === '连接就绪')
  assert.equal(await page.locator('#save').isDisabled(),true)
  await page.locator('#logout').click(); await page.locator('#locked').waitFor({ state:'visible' })
  const reopened = await context.newPage()
  await reopened.goto(server.issueLaunchUrl()); await reopened.locator('#workspace').waitFor({ state:'visible' })
  assert.equal(await reopened.locator('#upstreamFields').isVisible(),false)
  assert.deepEqual(errors,[])
  await context.close()
  process.stdout.write(JSON.stringify({ managedConfiguration:'pass',noTokenInput:'pass',threeLanguages:'pass',reopen:'pass' })+'\n')
} finally { await browser?.close(); await server.close() }
