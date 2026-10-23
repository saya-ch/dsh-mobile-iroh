/** Isolated public-Mobile-Gateway acceptance; never opens a normal DSH profile. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, request as requestHttp } from 'node:http'
import { Agent as HttpsAgent, request as requestHttps } from 'node:https'
import { createRequire } from 'node:module'
import { createConnection, createServer as createTcpServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { connect as connectTls } from 'node:tls'
import { promisify } from 'node:util'
import { createIrohGatewayFactory } from './mobile-gateway-factory.mjs'
import { irohHostname, irohOrigin } from './origin-contract.mjs'
import { waitForSocketEvent } from '../test-support/wait-for-socket.mjs'

const modulePath = process.env.DSH_MOBILE_MODULE
assert(modulePath && isAbsolute(modulePath), 'Set DSH_MOBILE_MODULE to the exact built public Mobile entry')
const useIroh = !process.argv.includes('--tcp-only')
const useAndroidCore = process.argv.includes('--android-core')
assert(!useAndroidCore || useIroh, 'Android-core acceptance requires QUIC, not the controlled TCP substitute')
const mobile = await import(pathToFileURL(modulePath).href)
const requireMobile = createRequire(modulePath)
const { generate } = requireMobile('selfsigned')
const { WebSocket, WebSocketServer } = requireMobile('ws')
const fixtureParent = process.platform === 'win32' ? homedir() : tmpdir()
const root = process.platform === 'win32'
  ? join(fixtureParent, `.dsh-mobile-iroh-gateway-${randomUUID()}`)
  : await mkdtemp(join(fixtureParent, 'dsh-mobile-iroh-gateway-'))
const cleanup = []
const checks = []
let modelRequests = 0
let browserRemoteAddress

async function listen(server, port = 0) {
  const sockets = new Set()
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  return server.address().port
}

const loopbackLookup = (_hostname, options, callback) => options?.all
  ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4)

try {
  const transportHelpers = await import('../src/first-party-fixture.mjs')
  if (process.platform === 'win32') {
    // The core creates a protected DACL before any TLS material is written.
    await transportHelpers.resolveSidecarIdentity({ executable: transportHelpers.firstPartyExecutable, dataDir: root })
  }
  const hostData = join(root, 'host')
  const endpointId = useIroh
    ? await transportHelpers.resolveSidecarIdentity({ executable: transportHelpers.firstPartyExecutable, dataDir: hostData }) : 'a'.repeat(64)
  const localPort = Number(process.env.IROH_LOCAL_PORT ?? 25443)
  const hostname = irohHostname(endpointId)
  const origin = irohOrigin(endpointId, localPort)
  const ca = await generate([{ name: 'commonName', value: 'Iroh isolated acceptance CA' }], {
    keyType: 'ec', curve: 'P-256', algorithm: 'sha256',
    extensions: [{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true }],
  })
  const leaf = await generate([{ name: 'commonName', value: hostname }], {
    keyType: 'ec', curve: 'P-256', algorithm: 'sha256', ca: { cert: ca.cert, key: ca.private },
    extensions: [{ name: 'basicConstraints', cA: false }, { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] }],
  })
  const tls = { caFile: join(root, 'ca.pem'), certFile: join(root, 'leaf.pem'), keyFile: join(root, 'leaf-key.pem') }
  await Promise.all([writeFile(tls.caFile, ca.cert, { mode: 0o600 }), writeFile(tls.certFile, leaf.cert, { mode: 0o600 }), writeFile(tls.keyFile, leaf.private, { mode: 0o600 })])
  const wss = new WebSocketServer({ noServer: true })
  wss.on('connection', socket => socket.on('message', bytes => socket.send(bytes)))
  cleanup.push(async () => { for (const socket of wss.clients) socket.terminate(); await new Promise(resolve => wss.close(resolve)) })
  const upstream = createHttpServer(async (request, response) => {
    if (request.url.startsWith('/api/session/prompt')) modelRequests += 1
    if (request.url === '/probe.html') {
      response.setHeader('content-type', 'text/html')
      response.end('<!doctype html><title>Iroh origin probe</title><h1 id="ready">TLS carrier</h1>')
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: true, bytes: Buffer.concat(chunks).toString('utf8') }))
  })
  upstream.on('upgrade', (request, socket, head) => wss.handleUpgrade(request, socket, head, client => wss.emit('connection', client)))
  const upstreamPort = await listen(upstream)
  // One-machine acceptance uses ::1 for the host and 127.0.0.1 for the phone,
  // keeping the same authority port without weakening Gateway validation.
  const factory = createIrohGatewayFactory({ mobile, endpointId, localPort, backendHost: '::1', upstreamOrigin: `http://127.0.0.1:${upstreamPort}`, stateFile: join(root, 'mobile-devices.json'), tls })
  const backend = await factory()
  cleanup.push(() => backend.close())
  assert.equal(backend.advertisedOrigin, origin)
  let nativeConnectPort
  if (useIroh) {
    const phoneExecutable = useAndroidCore
      ? fileURLToPath(new URL(`../target/debug/dsh-mobile-iroh-transport-sim${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url))
      : transportHelpers.firstPartyExecutable
    const carrier = await transportHelpers.startHostAndPhone({ proxyTarget: backend.proxyTarget, dataDir: root, proxyListen: `127.0.0.1:${localPort}`, expectedEndpointId: endpointId,
      phoneExecutable, phoneGracefulStdin: useAndroidCore })
    cleanup.push(() => carrier.close())
    checks.push('first-party local QUIC carries raw TLS without header or credential injection')
    if (useAndroidCore) {
      const metadata = JSON.parse(await readFile(join(carrier.phoneDataDir, 'transport-metadata.json'), 'utf8'))
      assert.deepEqual(Object.keys(metadata).sort(), ['connectProxyPort', 'localPort', 'peerId', 'version'])
      assert.equal(metadata.peerId, endpointId)
      assert.equal(metadata.localPort, localPort)
      assert.equal(metadata.version, 1)
      assert(Number.isInteger(metadata.connectProxyPort) && metadata.connectProxyPort > 0)
      nativeConnectPort = metadata.connectProxyPort
      checks.push('phone carrier executes the actual Android transport crate, not the separate phone-sim implementation')
    }
  } else {
    const targetPort = new URL(backend.proxyTarget).port
    const carrier = createTcpServer(phone => {
      const host = createConnection({ host: '::1', port: Number(targetPort) })
      phone.on('error', () => host.destroy())
      host.on('error', () => phone.destroy())
      phone.once('close', () => host.destroy())
      host.once('close', () => phone.destroy())
      phone.pipe(host); host.pipe(phone)
    })
    await listen(carrier, localPort)
    checks.push('controlled raw TCP carrier only; not QUIC evidence')
  }

  const nativeAgent = nativeConnectPort === undefined ? undefined : new HttpsAgent({ keepAlive: false })
  if (nativeAgent !== undefined) {
    nativeAgent.createConnection = (_options, callback) => {
      let done = false
      const complete = (error, socket) => { if (!done) { done = true; callback(error, socket) } }
      const connect = requestHttp({ host: '127.0.0.1', port: nativeConnectPort, method: 'CONNECT', path: new URL(origin).host,
        agent: false, signal: AbortSignal.timeout(5000), headers: { host: new URL(origin).host } })
      connect.once('connect', (response, socket, head) => {
        if (response.statusCode !== 200 || head.length !== 0) { socket.destroy(); complete(new Error('Native CONNECT rejected')); return }
        const tlsSocket = connectTls({ socket, ca: ca.cert, servername: hostname })
        complete(null, tlsSocket)
      })
      connect.once('error', error => complete(error))
      connect.end()
    }
    cleanup.push(async () => nativeAgent.destroy())
  }
  const request = (path, { method = 'GET', body, headers = {}, servername = hostname, trustedCa = ca.cert, viaNative = false } = {}) => new Promise((resolve, reject) => {
    assert(!viaNative || nativeAgent !== undefined)
    const outgoing = requestHttps({ host: '127.0.0.1', port: localPort, servername, ca: trustedCa, agent: viaNative ? nativeAgent : false,
      method, path, signal: AbortSignal.timeout(5000), headers: { host: new URL(origin).host, accept: 'application/json', origin,
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }), ...headers },
    }, incoming => {
      const chunks = []
      incoming.on('data', chunk => chunks.push(chunk))
      incoming.once('error', reject)
      incoming.once('end', () => resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    outgoing.once('error', reject)
    outgoing.end(body)
  })
  assert.equal((await request('/mobile-access/health')).status, 200)
  assert.equal((await request('/api/ping')).status, 401)
  await assert.rejects(request('/mobile-access/health', { trustedCa: leaf.cert }))
  await assert.rejects(request('/mobile-access/health', { servername: irohHostname('b'.repeat(64)) }))
  checks.push('unpaired HTTP denied; TLS wrong CA and wrong hostname rejected')
  const window = await backend.gateway.access.openPairing()
  const paired = await request('/mobile-access/auth/native-pair', { method: 'POST', viaNative: useAndroidCore, body: JSON.stringify({ token: window.token, label: 'isolated iroh acceptance' }) })
  assert.equal(paired.status, 201, paired.body)
  const credential = JSON.parse(paired.body)
  const cookie = `${mobile.SESSION_COOKIE}=${credential.sessionToken}; ${mobile.CSRF_COOKIE}=${credential.csrfToken}`
  assert.equal(credential.instanceId, backend.instanceId)
  assert.equal((await request('/api/ping', { headers: { cookie } })).status, 200)
  assert.equal((await request('/api/echo', { method: 'POST', body: '{}', headers: { cookie } })).status, 403)
  assert.equal((await request('/api/echo', { method: 'POST', body: '[]', headers: { cookie, [mobile.CSRF_HEADER]: credential.csrfToken } })).status, 200)
  assert.equal((await request('/api/ping', { headers: { cookie, host: 'other.example' } })).status, 403)
  assert.equal((await request('/api/echo', { method: 'POST', body: '{}', headers: { cookie, origin: 'https://other.example', [mobile.CSRF_HEADER]: credential.csrfToken } })).status, 403)
  checks.push('native device pairing, authenticated HTTP, exact authority/Origin and CSRF retained')
  if (useAndroidCore) checks.push('native pairing uses the Android CONNECT bridge with normal TLS CA and hostname verification')
  if (useAndroidCore && process.argv.includes('--jvm')) {
    const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java'
    const source = fileURLToPath(new URL('../test-support/JvmHttpsProbe.java', import.meta.url))
    const runJava = async caFile => promisify(execFile)(java, [source, origin, String(nativeConnectPort), caFile], { timeout: 20000, windowsHide: true, maxBuffer: 64 * 1024 })
    const positive = await runJava(tls.caFile)
    assert(positive.stdout.includes('JAVA_HTTPS_PROXY_PIN_OK'))
    const otherCa = await generate([{ name: 'commonName', value: 'Rejected isolated root' }], { keyType: 'ec', curve: 'P-256', extensions: [{ name: 'basicConstraints', cA: true }] })
    const wrongCaFile = join(root, 'wrong-ca.pem')
    await writeFile(wrongCaFile, otherCa.cert, { mode: 0o600 })
    await assert.rejects(runJava(wrongCaFile), error => error.code === 1 && error.stderr.includes('JAVA_HTTPS_PROXY_FAILED:SSLHandshakeException'))
    checks.push('standard Java HttpsURLConnection uses native CONNECT without DNS changes; explicit correct CA succeeds and wrong CA fails')
  }

  const websocket = new WebSocket(`${origin.replace('https:', 'wss:')}/api/events.mux`, { ca: ca.cert, lookup: loopbackLookup, headers: { cookie, origin }, handshakeTimeout: 5000 })
  websocket.on('error', () => {}) // Active waits report errors; termination may emit a later error during cleanup.
  cleanup.push(async () => websocket.terminate())
  await waitForSocketEvent(websocket, 'open')
  const echo = waitForSocketEvent(websocket, 'message', { select: value => value.toString() })
  websocket.send('iroh-tls-echo')
  assert.equal(await echo, 'iroh-tls-echo')
  const forbiddenSocket = new WebSocket(`${origin.replace('https:', 'wss:')}/unapproved/ws`, { ca: ca.cert, lookup: loopbackLookup, headers: { cookie, origin }, handshakeTimeout: 5000 })
  forbiddenSocket.on('error', () => {}) // Expected rejection and owned cleanup still need a listener after the wait settles.
  cleanup.push(async () => forbiddenSocket.terminate())
  const forbiddenStatus = await waitForSocketEvent(forbiddenSocket, 'unexpected-response', {
    rejectEvents: ['open'],
    select: (_request, response) => { response.resume(); return response.statusCode },
  })
  forbiddenSocket.terminate()
  assert.equal(forbiddenStatus, 404)
  checks.push('authenticated WSS upgrade/frame preserved; unapproved WS path denied')

  if (process.argv.includes('--browser')) {
    const { chromium } = requireMobile('playwright')
    const spki = createHash('sha256').update(new X509Certificate(leaf.cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
    const browser = await chromium.launch({ headless: true, args: [`--ignore-certificate-errors-spki-list=${spki}`,
      `--host-resolver-rules=MAP ${hostname} 127.0.0.1`, '--no-proxy-server'] })
    cleanup.push(() => browser.close())
    const context = await browser.newContext()
    await context.addCookies([{ name: mobile.SESSION_COOKIE, value: credential.sessionToken, url: origin, httpOnly: true, secure: true, sameSite: 'Strict' }])
    const page = await context.newPage()
    const document = await page.goto(`${origin}/probe.html`, { waitUntil: 'domcontentloaded', timeout: 10000 })
    assert.equal(document.status(), 200)
    browserRemoteAddress = await document.serverAddr()
    assert.equal(browserRemoteAddress?.ipAddress, '127.0.0.1', 'Browser bypassed the phone loopback carrier')
    assert.equal(browserRemoteAddress.port, localPort)
    assert.equal(await page.locator('#ready').textContent(), 'TLS carrier')
    assert.equal(await page.evaluate(() => location.origin), origin)
    assert.equal((await context.cookies(irohOrigin('b'.repeat(64), localPort))).length, 0)
    checks.push('Chromium fixture maps only the identity hostname to the phone IPv4 carrier; actual document remote IP/port, HTTPS Origin and host-scoped Cookie verified (only owned certificate SPKI allowed)')
  }
  const closed = waitForSocketEvent(websocket, 'close')
  assert.equal(await backend.gateway.access.revokeDevice(credential.deviceId), true)
  await closed
  assert.equal((await request('/api/ping', { headers: { cookie } })).status, 401)
  assert.equal((await request('/mobile-access/auth/native-renew', { method: 'POST', body: JSON.stringify({ deviceToken: credential.deviceToken }) })).status, 401)
  checks.push('Mobile device revocation closes active WSS and rejects old HTTP/native renewal')
  assert.equal(modelRequests, 0)
  console.log(JSON.stringify({ transport: useAndroidCore ? 'android-core-local-quic' : useIroh ? 'first-party-local-quic' : 'controlled-tcp', checks, modelRequests,
    ...(browserRemoteAddress ? { browserRemoteAddress, browserFixtureHostMapping: true } : {}), publicNetwork: false, physicalAndroid: false }))
} finally {
  const failures = []
  for (const close of cleanup.reverse()) { try { await close() } catch (error) { failures.push(error) } }
  assert.equal(dirname(root), fixtureParent)
  assert(/^[.]?dsh-mobile-iroh-gateway-/u.test(basename(root)))
  if (failures.length === 0) {
    try { await rm(root, { recursive: true, force: true }) } catch (error) { failures.push(error) }
  }
  if (failures.length) {
    console.error(JSON.stringify({ cleanup: 'failed', preservedFixtureRoot: root }))
    throw new AggregateError(failures, 'isolated gateway cleanup failed; owned root preserved')
  }
  console.log('Isolated gateway cleanup completed')
}
