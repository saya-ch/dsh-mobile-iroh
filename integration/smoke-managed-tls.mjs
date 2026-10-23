/** Real public Gateway TLS rollover through a fresh local-QUIC carrier; no user profile or model. */
import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { request as requestHttps } from 'node:https'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import { connect } from 'node:tls'
import { pathToFileURL } from 'node:url'
import { createSidecarFixtureRoot, firstPartyExecutable, startHostAndPhone } from '../src/first-party-fixture.mjs'
import { NativeTlsManager } from './native-tls-manager.mjs'
import { createIrohGatewayFactory } from './mobile-gateway-factory.mjs'
import { waitForSocketEvent } from '../test-support/wait-for-socket.mjs'

const modulePath = process.env.DSH_MOBILE_MODULE
assert(modulePath && isAbsolute(modulePath), 'Set DSH_MOBILE_MODULE to the exact public Mobile entry')
const localPort = Number(process.env.IROH_LOCAL_PORT ?? 25445)
const mobile = await import(pathToFileURL(modulePath).href)
const { WebSocket, WebSocketServer } = createRequire(modulePath)('ws')
const owned = await createSidecarFixtureRoot('managed-tls-smoke')
const dataDirectory = join(owned.directory, 'host')
const manager = new NativeTlsManager({ executable: firstPartyExecutable, dataDirectory })
const otherManager = new NativeTlsManager({ executable: firstPartyExecutable, dataDirectory: join(owned.directory, 'other') })
const upstream = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end('{"ok":true}') })
const upstreamSockets = new Set()
upstream.on('connection', socket => { upstreamSockets.add(socket); socket.once('close', () => upstreamSockets.delete(socket)); socket.on('error', () => socket.destroy()) })
const wss = new WebSocketServer({ noServer: true })
wss.on('connection', socket => socket.on('message', bytes => socket.send(bytes)))
upstream.on('upgrade', (request, socket, head) => wss.handleUpgrade(request, socket, head, client => wss.emit('connection', client)))
let backend, carrier, websocket
try {
  const prepared = await manager.prepare()
  const other = await otherManager.prepare()
  const ca = await readFile(prepared.tls.caFile, 'utf8')
  const wrongCa = await readFile(other.tls.caFile, 'utf8')
  await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve) })
  backend = await createIrohGatewayFactory({ mobile, endpointId: prepared.endpointId, localPort, backendHost: '::1',
    upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, stateFile: join(owned.directory, 'mobile-devices.json'), tlsManager: manager })()
  carrier = await startHostAndPhone({ executable: firstPartyExecutable, proxyTarget: backend.proxyTarget,
    dataDir: owned.directory, proxyListen: `127.0.0.1:${localPort}`, expectedEndpointId: prepared.endpointId })
  const origin = backend.advertisedOrigin, hostname = prepared.hostname
  const request = (path, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const outgoing = requestHttps({ host: '127.0.0.1', port: localPort, ca, servername: hostname, method, path,
      agent: false, signal: AbortSignal.timeout(5000), headers: { host: new URL(origin).host, origin, accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }), ...headers } }, response => {
      const chunks = []; response.on('data', bytes => chunks.push(bytes)); response.once('error', reject)
      response.once('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    outgoing.once('error', reject); outgoing.end(body)
  })
  const handshake = ({ trustedCa = ca, servername = hostname } = {}) => new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: localPort, ca: trustedCa, servername, rejectUnauthorized: true })
    const deadline = setTimeout(() => { socket.destroy(); reject(new Error('TLS handshake timeout')) }, 5000)
    socket.once('error', error => { clearTimeout(deadline); reject(error) })
    socket.once('secureConnect', () => { clearTimeout(deadline); const leaf = new X509Certificate(socket.getPeerCertificate().raw); socket.end(); resolve(leaf.fingerprint256.replaceAll(':', '').toLowerCase()) })
  })
  assert.equal(await handshake(), prepared.leafFingerprint256)
  await assert.rejects(handshake({ trustedCa: wrongCa }))
  await assert.rejects(handshake({ servername: other.hostname }))
  assert.equal((await request('/api/ping')).status, 401)
  const pairing = await backend.gateway.access.openPairing()
  const paired = await request('/mobile-access/auth/native-pair', { method: 'POST', body: JSON.stringify({ token: pairing.token, label: 'isolated TLS renewal' }) })
  assert.equal(paired.status, 201)
  const credentials = JSON.parse(paired.body)
  const cookie = `${mobile.SESSION_COOKIE}=${credentials.sessionToken}; ${mobile.CSRF_COOKIE}=${credentials.csrfToken}`
  assert.equal((await request('/api/ping', { headers: { cookie } })).status, 200)
  const lookup = (_name, options, done) => options?.all ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4)
  websocket = new WebSocket(`${origin.replace('https:', 'wss:')}/api/events.mux`, { ca, lookup, headers: { cookie, origin }, handshakeTimeout: 5000 })
  websocket.on('error', () => {})
  await waitForSocketEvent(websocket, 'open')
  const echo = async text => { const response = waitForSocketEvent(websocket, 'message', { select: bytes => bytes.toString() }); websocket.send(text); assert.equal(await response, text) }
  await echo('before-leaf-rollover')
  const rolled = await backend.renewTls()
  assert.notEqual(rolled.leafFingerprint256, prepared.leafFingerprint256)
  assert.equal(rolled.caFingerprint256, prepared.caFingerprint256)
  assert.equal(rolled.instanceId, prepared.instanceId)
  assert.equal(await handshake(), rolled.leafFingerprint256)
  assert.equal((await request('/api/ping', { headers: { cookie } })).status, 200)
  await echo('after-leaf-rollover')
  // Fault injection changes only this owned fixture's key file and restores its
  // exact bytes; neither the native owner nor production code repairs corruption.
  const validKey = await readFile(prepared.tls.keyFile)
  try {
    await writeFile(prepared.tls.keyFile, 'invalid-owned-fixture-key')
    await assert.rejects(backend.gateway.refreshProvidedTls())
    assert.equal(await handshake(), rolled.leafFingerprint256)
    assert.equal((await request('/api/ping', { headers: { cookie } })).status, 200)
    await echo('failed-rollover-retains-session')
    await assert.rejects(manager.prepare())
  } finally { await writeFile(prepared.tls.keyFile, validKey) }
  const retried = await backend.renewTls()
  assert.notEqual(retried.leafFingerprint256, rolled.leafFingerprint256)
  assert.equal(await handshake(), retried.leafFingerprint256)
  await echo('explicit-retry-retains-session')
  assert.equal((await request('/api/ping', { headers: { cookie } })).status, 200)
  console.log(JSON.stringify({ status: 'passed', transport: 'first-party-local-quic', publicGatewayModule: modulePath,
    automaticPrivateProvisioning: true, durableCaEndpointAndInstance: true, exactDnsSan: true,
    ordinaryCaAndNameValidation: true, wrongCaAndNameRejected: true, liveLeafRenewalWithoutRestart: true,
    newHandshakeSeesNewLeaf: true, existingCookieAndWebsocketRetained: true,
    malformedRefreshKeepsOldContext: true, corruptNativeMaterialNotRepaired: true, explicitRetry: true,
    physicalAndroid: false, publicNetwork: false, modelRequests: 0 }))
} finally {
  const failures = []
  websocket?.terminate()
  for (const close of [() => carrier?.close(), () => backend?.close(), () => manager.close(), () => otherManager.close()]) {
    try { await close() } catch (error) { failures.push(error) }
  }
  for (const socket of wss.clients) socket.terminate()
  await new Promise(resolve => wss.close(resolve))
  for (const socket of upstreamSockets) socket.destroy()
  await new Promise(resolve => upstream.close(resolve))
  if (failures.length === 0) await owned.cleanup()
  else throw new AggregateError(failures, 'managed TLS fixture cleanup failed; owned files retained')
}
