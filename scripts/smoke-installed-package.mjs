/** Exercise only installed npm runtime files and their bundled native Host; no DSH model requests. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { request } from 'node:https'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createSidecarFixtureRoot } from '../src/first-party-fixture.mjs'

const args = process.argv.slice(2)
assert(args.length === 2 && args[0] === '--package-root' && isAbsolute(args[1] ?? ''), 'Pass --package-root <installed absolute package directory>')
const root = args[1]
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
assert.equal(pkg.name, 'dsh-mobile-iroh')
const plugin = await import(pathToFileURL(join(root, 'plugin/index.mjs')).href)
assert.equal(plugin.name, pkg.name)
assert.equal(typeof plugin.apply, 'function')
const { resolveNativeHost } = await import(pathToFileURL(join(root, 'src/native-artifact.mjs')).href)
const executable = await resolveNativeHost()
const modulePath = createRequire(join(root, 'package.json')).resolve('dsh-mobile')
const mobile = await import(pathToFileURL(modulePath).href)
const { createOperatorOwner } = await import(pathToFileURL(join(root, 'integration/operator-owner.mjs')).href)
const owned = await createSidecarFixtureRoot('installed-npm')
const dataDirectory = join(owned.directory, 'host')
const upstream = createServer((_request, response) => { response.writeHead(404); response.end() })
const sockets = new Set()
upstream.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
let owner, failure, cleanupFailure
try {
  await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve) })
  const reservation = createTcpServer()
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve) })
  const localPort = reservation.address().port
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  owner = createOperatorOwner({ mobile, modulePath, executable, dataDirectory })
  await owner.initialize()
  await owner.configure({ version: 1, localOnly: true, localPort,
    upstreamAuthenticatedUrl: `http://127.0.0.1:${upstream.address().port}/?token=${randomBytes(32).toString('base64url')}` })
  await owner.start()
  const status = owner.status()
  assert.equal(status.state, 'ready'); assert.equal(status.tls.state, 'valid')
  const origin = new URL(status.origin)
  const ca = await readFile(join(dataDirectory, 'tls/ca.pem'))
  await new Promise((resolve, reject) => {
    const call = request({ hostname: '127.0.0.1', port: localPort, servername: origin.hostname,
      headers: { Host: origin.host }, path: '/mobile-access/health', ca, rejectUnauthorized: true }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.once('error', reject)
      response.once('end', () => { try { assert.equal(response.statusCode, 200); assert.equal(JSON.parse(Buffer.concat(chunks).toString()).ok, true); resolve() } catch (error) { reject(error) } })
    })
    call.setTimeout(10_000, () => call.destroy(new Error('installed_gateway_health_timeout')))
    call.once('error', reject); call.end()
  })
  await owner.openPairing()
  await owner.cancelPairing()
  assert.deepEqual(await owner.listPeers(), [])
} catch (error) { failure = error }
finally {
  try { await owner?.close() } catch (error) { cleanupFailure = error }
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => upstream.close(resolve))
  if (!cleanupFailure) await owned.cleanup()
}
if (cleanupFailure) throw new Error('Installed package cleanup incomplete; owned private state retained', { cause: cleanupFailure })
if (failure) throw failure
console.log(JSON.stringify({ installedPackage: pkg.name, version: pkg.version, platform: process.platform, arch: process.arch,
  nativeChecksum: 'verified', privateTls: 'verified', gatewayHealth: 200, pairingCancellation: 'passed', cleanup: 'complete', modelRequests: 0 }))
