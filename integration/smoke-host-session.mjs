/** Opt-in operator API acceptance using real public Mobile Gateway and QUIC. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { request as requestHttps } from 'node:https'
import { createRequire } from 'node:module'
import { createServer as createTcpServer } from 'node:net'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHostSession } from './host-session.mjs'
import { irohHostname } from './origin-contract.mjs'
import { MAX_PAIRING_DESCRIPTOR_BYTES } from './pairing-descriptor.mjs'
import { createSidecarFixtureRoot, firstPartyExecutable, resolveSidecarIdentity, startPhone } from '../src/first-party-fixture.mjs'
import { SidecarController } from '../src/sidecar-controller.mjs'

const modulePath = process.env.DSH_MOBILE_MODULE
assert(modulePath && isAbsolute(modulePath), 'Set DSH_MOBILE_MODULE to the exact built public Mobile entry')
const mobile = await import(pathToFileURL(modulePath).href)
const { generate } = createRequire(modulePath)('selfsigned')
const qrCode = createRequire(modulePath)('qrcode')
const owned = await createSidecarFixtureRoot('operator-smoke'), dataDirectory = join(owned.directory, 'host')
let session, phone, upstream, sidecar
let enabled = false, modelRequests = 0
const sockets = new Set()
const bounded = async (promise, timeoutMs, message) => {
  let timer
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) })]) }
  finally { clearTimeout(timer) }
}
try {
  const endpointId = await resolveSidecarIdentity({ executable: firstPartyExecutable, dataDir: dataDirectory })
  const reservation = createTcpServer()
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '::1', resolve) })
  const localPort = reservation.address().port
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()))
  const ca = await generate([{ name: 'commonName', value: 'Iroh operator smoke CA' }], { keyType: 'ec', curve: 'P-256', algorithm: 'sha256',
    extensions: [{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true }] })
  const leaf = await generate([{ name: 'commonName', value: irohHostname(endpointId) }], { keyType: 'ec', curve: 'P-256', algorithm: 'sha256', ca: { cert: ca.cert, key: ca.private },
    extensions: [{ name: 'basicConstraints', cA: false }, { name: 'extKeyUsage', serverAuth: true }, { name: 'subjectAltName', altNames: [{ type: 2, value: irohHostname(endpointId) }] }] })
  const tls = { caFile: join(dataDirectory, 'ca.pem'), certFile: join(dataDirectory, 'leaf.pem'), keyFile: join(dataDirectory, 'leaf-key.pem') }
  await Promise.all([writeFile(tls.caFile, ca.cert, { flag: 'wx', mode: 0o600 }), writeFile(tls.certFile, leaf.cert, { flag: 'wx', mode: 0o600 }), writeFile(tls.keyFile, leaf.private, { flag: 'wx', mode: 0o600 })])
  upstream = createServer((request, response) => {
    if (request.url.startsWith('/api/session/prompt')) modelRequests += 1
    response.setHeader('content-type', 'application/json'); response.end('{"ok":true}')
  })
  upstream.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve) })
  session = createHostSession({ mobile, executable: firstPartyExecutable, dataDirectory,
    upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, tls, backendHost: '::1', localPort, localOnly: true,
    store: { load: async () => ({ version: 1, enabled }), save: async (state) => { enabled = state.enabled } },
    sidecarFactory: (options) => { sidecar = new SidecarController(options); return sidecar },
  })
  await session.start()
  const { descriptor, qrPayload } = await session.openPairing()
  assert.equal(descriptor.endpointId, endpointId); assert.ok(qrPayload.length > 0)
  const renderedQr = qrCode.create([{ data: Buffer.from(qrPayload, 'utf8'), mode: 'byte' }], { errorCorrectionLevel: 'M' })
  assert(renderedQr.version >= 1 && renderedQr.version <= 40, 'combined descriptor must fit a real QR')
  const maximumQr = qrCode.create([{ data: Buffer.alloc(MAX_PAIRING_DESCRIPTOR_BYTES, 0x61), mode: 'byte' }], { errorCorrectionLevel: 'M' })
  assert(maximumQr.version <= 40, 'descriptor byte limit must fit M correction without text-mode optimization')
  const ready = sidecar.events.find((event) => event.type === 'ready')
  phone = await startPhone({ dataDir: join(owned.directory, 'phone'), endpointId, peerAddresses: ready.direct_addresses, code: descriptor.irohCode, proxyListen: `127.0.0.1:${localPort}` })
  const request = (path, { body, cookie } = {}) => new Promise((resolve, reject) => {
    const outgoing = requestHttps({ host: '127.0.0.1', port: localPort, servername: irohHostname(endpointId), ca: ca.cert, agent: false, path,
      method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(5000),
      headers: { host: new URL(descriptor.origin).host, origin: descriptor.origin, ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }) },
    }, (response) => {
      const chunks = []; response.on('data', (chunk) => chunks.push(chunk)); response.once('error', reject)
      response.once('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
    })
    outgoing.once('error', reject); outgoing.end(body)
  })
  assert.equal((await request('/api/ping')).status, 401)
  const paired = await request('/mobile-access/auth/native-pair', { body: JSON.stringify({ token: descriptor.gatewayToken, label: 'operator smoke' }) })
  assert.equal(paired.status, 201)
  const credential = JSON.parse(paired.text)
  const cookie = `${mobile.SESSION_COOKIE}=${credential.sessionToken}; ${mobile.CSRF_COOKIE}=${credential.csrfToken}`
  assert.equal((await request('/api/ping', { cookie })).status, 200)
  const peers = await session.listPeers()
  assert.equal(peers.length, 1)
  assert.deepEqual(await session.forgetPeer(peers[0].id), [])
  await bounded(phone.closed, 5000, 'forgotten peer did not close')
  await session.stop(); assert.equal(enabled, false); assert.equal(session.status().state, 'off')
  await session.start(); assert.equal(session.status().endpointId, endpointId)
  assert.equal(modelRequests, 0)
  console.log(JSON.stringify({ status: 'passed', owner: 'trusted-in-process HostSession', transport: 'first-party-local-quic', freshCombinedQr: true,
    qrErrorCorrection: 'M', qrVersion: renderedQr.version,
    nativeMobilePairing: true, authenticatedHttps: true, listAndForgetPeers: true, injectedStoreStopAndExplicitRestart: true, modelRequests, publicNetwork: false, physicalAndroid: false }))
} finally {
  const failures = []
  try { await phone?.stop() } catch (error) { failures.push(error) }
  try { await session?.close() } catch (error) { failures.push(error) }
  for (const socket of sockets) socket.destroy()
  if (upstream) await new Promise((resolve) => upstream.close(() => resolve()))
  try { await owned.cleanup() } catch (error) { failures.push(error) }
  if (failures.length) throw new AggregateError(failures, 'operator smoke cleanup failed')
}
