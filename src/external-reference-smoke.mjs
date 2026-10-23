import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { createSidecarFixtureRoot, firstPartyExecutable, resolveSidecarIdentity } from './first-party-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const defaultBinary = resolve(here, '../artifacts/host-0.1.22/package/bin/tether-host.exe')
const binary = process.env.TETHER_HOST_BIN ?? defaultBinary

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const freePort = async () => {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

const waitFor = async (events, predicate, timeout = 20_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const found = events.find(predicate)
    if (found) return found
    await sleep(50)
  }
  throw new Error(`timed out waiting for event; observed ${JSON.stringify(events)}`)
}

const spawnSidecar = (args) => {
  const child = spawn(binary, ['--lang', 'en', ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const stdout = []
  const stderr = []
  const output = createInterface({ input: child.stdout })
  output.on('line', (line) => {
    try {
      stdout.push(JSON.parse(line))
    } catch {
      stdout.push({ type: 'unparsed-stdout', line })
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  return { child, stdout, stderr }
}

const kill = async (child) => {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') {
    await new Promise((resolve) => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => resolve()))
  } else {
    child.kill()
  }
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(2_000),
  ])
}

const ownedRoot = await createSidecarFixtureRoot('external-reference')
const root = ownedRoot.directory
const target = createServer((request, response) => response.end(`smoke:${request.url}`))
let host
let phone

try {
  // The reference binary predates this repository's Windows ACL enforcement.
  // Prepare fresh private identity directories through the first-party owner;
  // the external reference then inherits their protected ACLs for its state.
  await resolveSidecarIdentity({ executable: firstPartyExecutable, dataDir: join(root, 'host') })
  await resolveSidecarIdentity({ executable: firstPartyExecutable, dataDir: join(root, 'phone') })
  await new Promise((resolve, reject) => {
    target.once('error', reject)
    target.listen(0, '127.0.0.1', resolve)
  })
  const targetPort = target.address().port
  const proxyPort = await freePort()
  host = spawnSidecar([
    'host',
    '--data-dir', join(root, 'host'),
    '--pair',
    '--proxy-target', `127.0.0.1:${targetPort}`,
  ])
  const ready = await waitFor(host.stdout, (event) => event.type === 'ready')
  const pairing = await waitFor(host.stdout, (event) => event.type === 'pairing')
  phone = spawnSidecar([
    'phone-sim',
    '--data-dir', join(root, 'phone'),
    '--peer', ready.endpoint_id,
    '--code', pairing.code,
    '--name', 'iroh-smoke',
    '--delay', '20',
    '--proxy-listen', `127.0.0.1:${proxyPort}`,
  ])
  await waitFor(phone.stderr, (chunk) => /\bpaired\b/.test(chunk), 25_000)
  await waitFor(host.stdout, (event) => event.type === 'peer-connected', 10_000)
  const response = await fetch(`http://127.0.0.1:${proxyPort}/smoke`)
  const body = await response.text()
  if (response.status !== 200 || body !== 'smoke:/smoke') {
    throw new Error(`proxy response mismatch: HTTP ${response.status} ${body}`)
  }
  host.child.stdin.write(JSON.stringify({
    type: 'approval',
    id: 'iroh-smoke-approval',
    tool_name: 'smoke',
    reason: 'local iroh smoke',
  }) + '\n')
  await waitFor(phone.stderr, (chunk) => /replied: allowed-once/.test(chunk), 10_000)
  await waitFor(host.stdout, (event) => event.type === 'decision' && event.id === 'iroh-smoke-approval', 10_000)
  console.log(JSON.stringify({ status: 'passed', transport: 'iroh', pairing: true, proxy: true, approval: true }))
} catch (error) {
  const diagnostics = [
    ...((host?.stderr ?? []).map((chunk) => chunk.trim()).filter(Boolean)),
    ...((phone?.stderr ?? []).map((chunk) => chunk.trim()).filter(Boolean)),
  ]
  const message = `${error instanceof Error ? error.message : String(error)}\n${diagnostics.join('\n')}`
  if (/No addressing information available|All address lookup services failed/i.test(message)) {
    console.error(JSON.stringify({
      status: 'blocked',
      reason: 'iroh endpoint discovery or relay addressing was unavailable',
      diagnostics,
    }, null, 2))
    process.exitCode = 2
  } else {
    console.error(message)
    process.exitCode = 1
  }
} finally {
  await kill(phone?.child)
  await kill(host?.child)
  await new Promise((resolve) => target.close(() => resolve()))
  await ownedRoot.cleanup()
}
