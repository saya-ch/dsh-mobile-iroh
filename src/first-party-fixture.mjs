import { spawn } from 'node:child_process'
import { lstat, mkdtemp, readdir, rm, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SidecarController, resolveSidecarIdentity, MAX_LINE_BYTES } from './sidecar-controller.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
export const firstPartyExecutable = resolve(root, `target/debug/dsh-mobile-iroh-host${process.platform === 'win32' ? '.exe' : ''}`)
export { resolveSidecarIdentity }

/**
 * Own one fresh fixture parent below the user profile, not a shared TEMP tree.
 * Sidecar data subdirectories remain absent until Rust creates protected ACLs;
 * this helper never changes the ACL of an existing user directory.
 */
export async function createSidecarFixtureRoot(label = 'first-party') {
  if (!/^[a-z0-9-]{1,48}$/u.test(label)) throw new Error('invalid sidecar fixture label')
  const parent = resolve(homedir())
  const prefix = `.dsh-mobile-iroh-${label}-`
  const directory = await mkdtemp(join(parent, prefix))
  return Object.freeze({
    directory,
    async cleanup() {
      if (dirname(directory) !== parent || !basename(directory).startsWith(prefix)) throw new Error('sidecar fixture cleanup target escaped its owned root')
      let metadata
      try { metadata = await lstat(directory) } catch (error) { if (error.code === 'ENOENT') return; throw error }
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('sidecar fixture root was replaced or linked')
      const unlinkProjections = async current => {
        for (const name of await readdir(current)) {
          const path = join(current, name)
          const info = await lstat(path)
          if (info.isSymbolicLink()) await unlink(path)
          else if (info.isDirectory()) await unlinkProjections(path)
        }
      }
      // DSH may project resolver links into an owned profile. Unlink them before
      // recursive removal; never traverse a junction into another installation.
      await unlinkProjections(directory)
      await rm(directory, { recursive: true, force: true })
    },
  })
}

/** Wait for one owned host event without printing pairing material. */
export function waitForSidecarEvent(host, predicate, { timeoutMs = 15_000 } = {}) {
  const known = host.events.find(predicate)
  if (known !== undefined) return Promise.resolve(known)
  return new Promise((resolve, reject) => {
    let remove = () => {}
    const deadline = setTimeout(() => { remove(); reject(new Error('sidecar event timeout')) }, timeoutMs)
    remove = host.onEvent((event) => {
      if (predicate(event)) { clearTimeout(deadline); remove(); resolve(event) }
      else if (['sidecar-exit', 'sidecar-error', 'sidecar-protocol-error', 'error'].includes(event.type)) {
        clearTimeout(deadline); remove(); reject(new Error(`sidecar event unavailable: ${event.type}`))
      }
    })
  })
}

/** Own a local phone stand-in. Its raw TCP socket can carry HTTPS unchanged. */
export async function startPhone({ executable = firstPartyExecutable, dataDir, endpointId, peerAddresses, code, proxyListen = '127.0.0.1:0', localOnly = true, readyTimeoutMs = 15_000, gracefulStdin = false, stopTimeoutMs = gracefulStdin ? 8000 : 2000, spawnImpl = spawn }) {
  if (!isAbsolute(executable) || !isAbsolute(dataDir) || !/^[0-9a-f]{64}$/u.test(endpointId)
    || !Array.isArray(peerAddresses) || typeof localOnly !== 'boolean' || localOnly && peerAddresses.length === 0 || typeof gracefulStdin !== 'boolean'
    || !Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs < 1) throw new Error('invalid first-party phone fixture')
  const args = ['--lang', 'en', 'phone-sim', '--data-dir', dataDir, '--peer', endpointId, '--name', 'first-party-smoke', '--proxy-listen', proxyListen]
  if (localOnly) args.push('--local-only')
  for (const address of peerAddresses) args.push('--peer-address', address)
  if (code !== undefined) args.push('--code', code)
  const child = spawnImpl(executable, args, { stdio: [gracefulStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true })
  let pending = Buffer.alloc(0), failed, stopped = false, stopTask
  let resolveReady, rejectReady
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const closed = new Promise((resolve) => child.once('close', (exitCode, signal) => {
    stopped = true; rejectReady(failed ?? new Error('phone exited before proxy ready')); resolve({ exitCode, signal })
  }))
  const stop = async () => {
    if (stopTask !== undefined) return stopTask
    stopTask = (async () => {
      if (stopped) return closed
      const waitForExit = async () => {
        let timeout
        try { return await Promise.race([closed, new Promise((resolve) => { timeout = setTimeout(() => resolve(undefined), stopTimeoutMs) })]) }
        finally { clearTimeout(timeout) }
      }
      if (gracefulStdin) {
        if (!child.stdin.destroyed) child.stdin.end()
        const graceful = await waitForExit()
        if (graceful !== undefined) return graceful
      }
      child.kill()
      const result = await waitForExit()
      if (result !== undefined) return result
      child.kill('SIGKILL')
      const final = await waitForExit()
      if (final === undefined) throw new Error('phone process did not stop')
      return final
    })()
    try { return await stopTask } finally { stopTask = undefined }
  }
  const fail = (code) => {
    failed ??= new Error(code)
    rejectReady(failed)
    void stop().catch(() => {})
  }
  child.stdout.on('data', (chunk) => {
    if (failed !== undefined) return
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset), end = newline === -1 ? chunk.length : newline
      if (pending.length + end - offset > MAX_LINE_BYTES) { fail('phone event too large'); return }
      pending = Buffer.concat([pending, chunk.subarray(offset, end)])
      if (newline === -1) return
      let event
      try {
        event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pending))
        if (Object.keys(event).sort().join(',') !== 'origin,type,version' || event.version !== 1 || event.type !== 'proxy-ready') throw new Error('invalid event')
        const origin = new URL(event.origin)
        if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.port === '' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('invalid proxy origin')
        event = Object.freeze({ ...event })
      } catch { fail('invalid phone proxy-ready event'); return }
      pending = Buffer.alloc(0); resolveReady(event); offset = newline + 1
    }
  })
  child.stdout.on('error', () => fail('phone stdout error'))
  child.stderr.on('error', () => {})
  child.stderr.resume()
  child.stdin?.on('error', () => fail('phone stdin error'))
  child.once('error', () => fail('phone process failed'))
  const deadline = setTimeout(() => fail('phone proxy-ready timeout'), readyTimeoutMs)
  try {
    const event = await ready
    return Object.freeze({ child, localAddress: event.origin, closed, stop, get exited() { return stopped } })
  } catch (error) { await stop(); throw error }
  finally { clearTimeout(deadline) }
}

/** Start an isolated first-party local QUIC pair against an explicit gateway. */
export async function startHostAndPhone({ executable = firstPartyExecutable, phoneExecutable = executable, phoneGracefulStdin = false, phoneStopTimeoutMs, proxyTarget, dataDir, proxyListen = '127.0.0.1:0', expectedEndpointId, readyTimeoutMs = 15_000 }) {
  if (!isAbsolute(dataDir)) throw new Error('first-party fixture dataDir must be absolute')
  const host = new SidecarController({ executable, dataDir: join(dataDir, 'host'), proxyTarget, readyTimeoutMs })
  const phoneDataDir = join(dataDir, 'phone')
  let phone
  const close = async () => {
    const errors = []
    try { await phone?.stop() } catch (error) { errors.push(error) }
    try { await host.stop() } catch (error) { errors.push(error) }
    if (errors.length > 0) throw new AggregateError(errors, 'first-party fixture cleanup failed')
  }
  try {
    const ready = await host.start({ pair: true, localOnly: true })
    if (expectedEndpointId !== undefined && ready.endpoint_id !== expectedEndpointId) throw new Error('first-party host identity changed')
    const pairing = await waitForSidecarEvent(host, (event) => event.type === 'pairing')
    phone = await startPhone({ executable: phoneExecutable, dataDir: phoneDataDir, endpointId: ready.endpoint_id, peerAddresses: ready.direct_addresses, code: pairing.code, proxyListen, localOnly: true, readyTimeoutMs, gracefulStdin: phoneGracefulStdin, stopTimeoutMs: phoneStopTimeoutMs })
    return { host, phone, phoneDataDir, localAddress: phone.localAddress, endpointId: ready.endpoint_id, peerAddresses: ready.direct_addresses, close }
  } catch (error) { await close(); throw error }
}
