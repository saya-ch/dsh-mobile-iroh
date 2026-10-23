/** Rebuild the complete Host and public Gateway while retaining durable transport and Mobile credentials. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { request as requestHttps } from 'node:https'
import { createServer } from 'node:net'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDshWebProfile, startDshWeb } from './dsh-web-fixture.mjs'
import { createHostSession } from './host-session.mjs'
import { NativeTlsManager } from './native-tls-manager.mjs'
import { NativePreferenceStore } from './native-preference-store.mjs'
import { irohHostname } from './origin-contract.mjs'
import { createSidecarFixtureRoot, firstPartyExecutable, startPhone } from '../src/first-party-fixture.mjs'
import { SidecarController } from '../src/sidecar-controller.mjs'

const modulePath = process.env.DSH_MOBILE_MODULE, dshBin = process.env.DSH_IROH_DSH_BIN
assert(isAbsolute(modulePath ?? '') && isAbsolute(dshBin ?? ''), 'Set absolute public Mobile and DSH artifact paths')
const mobile = await import(pathToFileURL(modulePath).href)
const owned = await createSidecarFixtureRoot('gateway-restart')
const dataDirectory = join(owned.directory, 'host'), phoneDirectory = join(owned.directory, 'phone')
let session, store, tlsManager, sidecar, phone, dsh, ca, endpointId, origin, localPort
let stage = 'isolated-public-DSH', failure, dshFixtureExit
const checks = [], cleanup = []

async function within(promise, label, timeoutMs = 10000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), timeoutMs) })]) }
  finally { clearTimeout(timer) }
}

function cookie(credential) {
  return `${mobile.SESSION_COOKIE}=${credential.sessionToken}; ${mobile.CSRF_COOKIE}=${credential.csrfToken}`
}

function documentView(html) {
  const matches = [...html.matchAll(/headers\.set\("x-dsh-mobile-view","([a-f0-9]{32})"\)/gu)]
  assert.equal(matches.length, 1, 'Real document must supply one bound Mobile view')
  return matches[0][1]
}

/** Consume a finite response or exactly the first real graph event, then close this owned HTTP stream. */
function request(path, { body, credential, view, graph = false } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false, received = 0, text = ''
    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (error) reject(error); else resolve(value)
      outgoing.destroy()
    }
    const outgoing = requestHttps({ hostname: '127.0.0.1', port: localPort, servername: irohHostname(endpointId), ca,
      agent: false, path, method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(15000),
      headers: { host: new URL(origin).host, origin,
        accept: graph ? 'text/event-stream' : path === '/' ? 'text/html' : 'application/json',
        ...(credential ? { cookie: cookie(credential) } : {}), ...(view ? { 'x-dsh-mobile-view': view } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }) },
    }, response => {
      response.setEncoding('utf8')
      response.on('data', chunk => {
        received += Buffer.byteLength(chunk)
        if (received > 4 * 1024 * 1024) { finish(new Error('Owned response exceeded byte limit')); return }
        text += chunk
        if (!graph || response.statusCode !== 200) return
        const frames = text.replaceAll('\r\n', '\n').split('\n\n')
        for (const frame of frames.slice(0, -1)) {
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
          if (!data) continue
          let event
          try { event = JSON.parse(data) } catch { finish(new Error('Real graph stream emitted malformed JSON')); return }
          if (event.type === 'graph') { finish(undefined, { status: response.statusCode, graph: event.graph }); response.destroy(); return }
        }
      })
      response.once('error', error => { if (!settled) finish(error) })
      response.once('end', () => finish(undefined, { status: response.statusCode, text }))
    })
    outgoing.once('error', error => { if (!settled) finish(error) })
    outgoing.end(body)
  })
}

async function newHost() {
  store = new NativePreferenceStore({ executable: firstPartyExecutable, dataDirectory })
  tlsManager = new NativeTlsManager({ executable: firstPartyExecutable, dataDirectory })
  session = createHostSession({ mobile, executable: firstPartyExecutable, dataDirectory, store, tlsManager,
    backendHost: '::1', localPort, localOnly: true, upstreamOrigin: dsh.origin, upstreamAuthenticatedUrl: dsh.authenticatedUrl,
    sidecarFactory: options => { sidecar = new SidecarController(options); return sidecar } })
}

async function connectPhone(code) {
  const ready = sidecar.events.find(event => event.type === 'ready')
  assert(ready && ready.direct_addresses.length > 0, 'The owned Host must advertise its real local QUIC listener')
  phone = await startPhone({ executable: firstPartyExecutable, dataDir: phoneDirectory, endpointId,
    peerAddresses: ready.direct_addresses, ...(code ? { code } : {}), proxyListen: `127.0.0.1:${localPort}`, localOnly: true })
}

try {
  await createDshWebProfile({ dshBin, mobileModule: modulePath, root: owned.directory })
  dsh = await startDshWeb({ dshBin, root: owned.directory })
  const reservation = createServer()
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '::1', resolve) })
  localPort = reservation.address().port
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  stage = 'first-host-and-pairing'
  await newHost(); await session.start()
  const { descriptor } = await session.openPairing()
  endpointId = descriptor.endpointId; origin = descriptor.origin
  ca = await readFile(join(dataDirectory, 'tls/ca.pem'))
  const firstTls = session.tlsStatus()
  await connectPhone(descriptor.irohCode)
  const paired = await request('/mobile-access/auth/native-pair', { body: JSON.stringify({ token: descriptor.gatewayToken, label: 'Gateway restart regression' }) })
  assert.equal(paired.status, 201)
  const originalCredential = JSON.parse(paired.text)
  const oldDocument = await request('/', { credential: originalCredential })
  assert.equal(oldDocument.status, 200)
  const oldView = documentView(oldDocument.text)
  const firstGraph = await request('/plugins/events', { credential: originalCredential, view: oldView, graph: true })
  assert.equal(firstGraph.status, 200); assert(Array.isArray(firstGraph.graph?.entries))
  checks.push('first persistent pairing and valid document-bound graph stream')

  stage = 'complete-host-and-gateway-disposal'
  await session.close()
  await within(phone.closed, 'Host disposal did not close the owned phone transport')
  await phone.stop(); phone = undefined
  await store.close(); await tlsManager.close()
  const previousSession = session, previousSidecar = sidecar
  session = undefined; store = undefined; tlsManager = undefined
  await newHost(); await session.restore()
  assert.notEqual(session, previousSession); assert.notEqual(sidecar, previousSidecar)
  assert.equal(session.status().endpointId, endpointId); assert.equal(session.status().origin, origin)
  assert.equal(session.tlsStatus().caFingerprint256, firstTls.caFingerprint256)
  assert.equal(session.tlsStatus().instanceId, firstTls.instanceId)
  await connectPhone()
  checks.push('distinct HostSession, Sidecar and Gateway recreated with the same identity, CA and Origin')

  stage = 'durable-device-token-renewal'
  assert.equal((await request('/mobile-access/client-modules', { credential: originalCredential })).status, 401, 'Old ephemeral session must not survive Gateway recreation')
  const renewed = await request('/mobile-access/auth/native-renew', { body: JSON.stringify({ deviceToken: originalCredential.deviceToken }) })
  assert.equal(renewed.status, 200, 'Durable device token must remain valid after Gateway recreation')
  const freshCredential = JSON.parse(renewed.text)
  assert.equal(freshCredential.deviceId, originalCredential.deviceId)
  assert.equal(freshCredential.instanceId, originalCredential.instanceId)
  assert(freshCredential.sessionToken !== originalCredential.sessionToken, 'Renewal must issue a distinct ephemeral session')
  assert.equal((await request('/mobile-access/client-modules', { credential: freshCredential })).status, 200)
  checks.push('old Cookie rejected, durable Token renewed, new Cookie authenticated HTTP succeeded')

  stage = 'stale-view-rejection-and-fresh-document'
  const stale = await request('/plugins/events', { credential: freshCredential, view: oldView })
  assert.equal(stale.status, 409)
  assert.equal(JSON.parse(stale.text).error, 'mobile_document_view_invalid')
  const newDocument = await request('/', { credential: freshCredential })
  assert.equal(newDocument.status, 200)
  const newView = documentView(newDocument.text)
  assert.notEqual(newView, oldView)
  const newGraph = await request('/plugins/events', { credential: freshCredential, view: newView, graph: true })
  assert.equal(newGraph.status, 200); assert(Array.isArray(newGraph.graph?.entries))
  checks.push('old document view remains 409; a fresh document binds a new view and receives its real graph')
  stage = 'complete'
} catch (error) { failure = error }
finally {
  for (const [name, close] of [['phone', () => phone?.stop()], ['session', () => session?.close()], ['preference', () => store?.close()],
    ['TLS', () => tlsManager?.close()], ['DSH', () => dsh?.close()]]) {
    try {
      const result = await close()
      if (name === 'DSH') dshFixtureExit = result
    } catch (error) { cleanup.push(new Error(`${name} cleanup failed`, { cause: error })) }
  }
  if (cleanup.length === 0 && !failure?.preserveFixtureRoot) {
    try { await owned.cleanup() } catch (error) { cleanup.push(error) }
  }
}
console.log(JSON.stringify({ status: failure || cleanup.length ? 'failed' : 'passed', stage, checks,
  realHostGatewayRecreation: true, transport: 'first-party-local-quic', physicalAndroid: false, publicNetwork: false,
  modelRequestsInitiated: 0, dshFixtureExit, cleanup: cleanup.length === 0 ? 'complete' : 'retained' }))
if (failure || cleanup.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanup], 'Complete Gateway restart regression failed')
