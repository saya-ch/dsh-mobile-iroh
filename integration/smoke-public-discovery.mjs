/** Opt-in N0 addressing check. Same-PC success is not cross-network NAT evidence. */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { createSidecarFixtureRoot, firstPartyExecutable, startPhone, waitForSidecarEvent } from '../src/first-party-fixture.mjs'
import { SidecarController } from '../src/sidecar-controller.mjs'

const TOTAL_WORK_BUDGET_MS = 35000
const PRIVATE_DIAGNOSTIC_LIMIT = 8192
const owned = await createSidecarFixtureRoot('public-discovery')
const children = new Set(), sockets = new Set()
const diagnostics = { host: Buffer.alloc(0), phone: Buffer.alloc(0) }
let host, phone, upstream, pairingCode, result, exitCode = 0, expired = false, budgetTimer, phase = 'host-setup'
const trackedSpawn = (source) => (file, args, options) => {
  const child = spawn(file, args, options)
  children.add(child); child.once('close', () => children.delete(child))
  child.stderr.on('data', (bytes) => {
    const retained = Buffer.concat([diagnostics[source], bytes])
    diagnostics[source] = retained.subarray(Math.max(0, retained.length - PRIVATE_DIAGNOSTIC_LIMIT))
  })
  return child
}
const checkBudget = () => { if (expired) throw new Error('public discovery work budget exceeded') }
const safeDiagnostic = (bytes) => {
  let value = bytes.toString('utf8').replaceAll(owned.directory, '<private-state>')
  if (pairingCode !== undefined) value = value.replaceAll(pairingCode, '<pairing-code>')
  return value.replace(/\b[A-Za-z0-9_-]{43,}\b/gu, '<identity-or-secret>').replace(/\b[0-9]{6}\b/gu, '<six-digits>')
}

try {
  const work = async () => {
    upstream = createServer((_request, response) => response.end('public-addressing-smoke'))
    upstream.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
    await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve) })
    checkBudget()
    host = new SidecarController({ executable: firstPartyExecutable, dataDir: join(owned.directory, 'host'),
      proxyTarget: `http://127.0.0.1:${upstream.address().port}`, spawnImpl: trackedSpawn('host'), readyTimeoutMs: 12000, stopTimeoutMs: 750 })
    const ready = await host.start({ pair: true, localOnly: false })
    checkBudget()
    const pairing = await waitForSidecarEvent(host, (event) => event.type === 'pairing', { timeoutMs: 3000 })
    pairingCode = pairing.code
    checkBudget()
    phase = 'default-address-discovery'
    // Pass the authenticated EndpointId only: no Ready IP, direct SocketAddr,
    // relay hint, mDNS fixture or preconfigured peer address is supplied.
    phone = await startPhone({ dataDir: join(owned.directory, 'phone'), endpointId: ready.endpoint_id, peerAddresses: [],
      code: pairing.code, localOnly: false, readyTimeoutMs: 25000, stopTimeoutMs: 750, spawnImpl: trackedSpawn('phone') })
    checkBudget()
    phase = 'http-forwarding'
    const response = await fetch(`${phone.localAddress}/probe`, { signal: AbortSignal.timeout(3000) })
    if (response.status !== 200 || await response.text() !== 'public-addressing-smoke') throw new Error('public discovery HTTP byte mismatch')
    checkBudget()
    let path
    try { path = await waitForSidecarEvent(host, (event) => event.type === 'peer-path', { timeoutMs: 1000 }) } catch { /* Byte forwarding does not require path telemetry. */ }
    checkBudget()
    return { status: 'passed', topology: 'two processes on one PC', addressing: 'iroh N0 defaults, EndpointId only', explicitPeerAddresses: false,
      pairing: true, httpBytes: true, selectedPath: path?.kind ?? 'unobserved', crossNetworkNat: false, physicalAndroid: false, modelRequests: 0 }
  }
  result = await Promise.race([work(), new Promise((_resolve, reject) => {
    budgetTimer = setTimeout(() => {
      expired = true
      for (const child of children) child.kill()
      reject(new Error('public discovery work budget exceeded'))
    }, TOTAL_WORK_BUDGET_MS)
  })])
} catch (error) {
  const reason = expired ? 'overall_public_discovery_budget_exceeded'
    : phase === 'host-setup' ? 'host_setup_failed'
      : phase === 'http-forwarding' ? 'http_forwarding_failed' : 'default_addressing_or_transport_unavailable'
  exitCode = expired || phase === 'default-address-discovery' ? 2 : 1
  result = { status: exitCode === 2 ? 'blocked' : 'failed', reason, topology: 'two processes on one PC',
    phase, explicitPeerAddresses: false, crossNetworkNat: false, physicalAndroid: false, modelRequests: 0 }
} finally {
  clearTimeout(budgetTimer)
  const cleanupErrors = []
  try { await phone?.stop() } catch { cleanupErrors.push('phone_cleanup_failed') }
  try { await host?.stop() } catch { cleanupErrors.push('host_cleanup_failed') }
  await Promise.all([...children].map(async (child) => {
    let timer
    const closed = new Promise((resolve) => child.once('close', () => resolve(true)))
    child.kill('SIGKILL')
    try {
      if (!await Promise.race([closed, new Promise((resolve) => { timer = setTimeout(() => resolve(false), 750) })])) cleanupErrors.push('owned_process_did_not_exit')
    } finally { clearTimeout(timer) }
  }))
  for (const socket of sockets) socket.destroy()
  if (upstream) await new Promise((resolve) => upstream.close(() => resolve()))
  try { await owned.cleanup() } catch { cleanupErrors.push('private_state_cleanup_failed') }
  if (cleanupErrors.length !== 0) { result = { ...result, status: 'failed', cleanupErrors }; exitCode = 1 }
  result = { ...result, cleanupComplete: cleanupErrors.length === 0, diagnostics: { host: safeDiagnostic(diagnostics.host), phone: safeDiagnostic(diagnostics.phone) } }
}
console.log(JSON.stringify(result))
process.exitCode = exitCode
