import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { isIP } from 'node:net'

const MAX_LINE_BYTES = 16 * 1024
const ENDPOINT_ID = /^[0-9a-f]{64}$/u
const text = (value, maximum = 256) => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value)
const exact = (value, fields) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...fields].sort().join(',')
const hostname = (value) => value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
const endpointId = (value) => typeof value === 'string' && ENDPOINT_ID.test(value)
const directAddress = (value) => {
  if (!text(value, 128)) return false
  try {
    const url = new URL(`http://${value}`)
    return isIP(hostname(url.hostname)) !== 0 && url.port !== '' && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}

/** Validate the loopback socket destination; TLS remains end to end. */
export function validateProxyTarget(value) {
  const target = new URL(value)
  if (!['http:', 'https:'].includes(target.protocol) || !['127.0.0.1', '::1'].includes(hostname(target.hostname))
    || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('sidecar proxy target must be an explicit HTTP(S) loopback origin')
  return target.origin
}

/** Strict parent-to-sidecar v1 command encoder. */
export function encodeCommand(message) {
  if (message?.version !== 1) throw new Error('invalid sidecar command version')
  const fields = message.type === 'device-forget' ? ['version', 'type', 'id'] : ['version', 'type']
  if (!exact(message, fields) || !['pairing-begin', 'device-list', 'device-forget', 'shutdown'].includes(message.type)
    || message.type === 'device-forget' && !endpointId(message.id)) throw new Error('invalid sidecar command')
  const line = JSON.stringify(message)
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error('sidecar command too large')
  return `${line}\n`
}

/** Decode exact first-party stdout events; no extension fields grant authority. */
export function decodeSidecarEvent(line) {
  if (typeof line !== 'string' || Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error('sidecar event too large')
  let event
  try { event = JSON.parse(line) } catch { throw new Error('invalid sidecar event JSON') }
  if (event?.version !== 1 || typeof event.type !== 'string') throw new Error('invalid sidecar event version')
  const base = ['version', 'type']
  const fields = {
    ready: ['endpoint_id', 'direct_addresses', 'local_only'], pairing: ['code', 'expires_in_sec'],
    'pairing-closed': ['reason'], 'pairing-done': ['peer', 'name'], 'peer-connected': ['peer', 'name'],
    'peer-path': ['peer', 'kind', 'remote'], 'peer-disconnected': ['peer'], 'proxy-opened': ['peer'],
    devices: ['devices'], error: ['code', 'message'], stopped: [],
  }[event.type]
  if (fields === undefined || !exact(event, [...base, ...fields])) throw new Error('invalid sidecar event fields')
  if ('peer' in event && !endpointId(event.peer)) throw new Error('invalid sidecar event peer')
  if ('name' in event && !text(event.name, 128)) throw new Error('invalid sidecar event name')
  switch (event.type) {
    case 'ready':
      if (!endpointId(event.endpoint_id) || typeof event.local_only !== 'boolean' || !Array.isArray(event.direct_addresses)
        || event.direct_addresses.length > 64 || !event.direct_addresses.every(directAddress)) throw new Error('invalid sidecar ready event')
      event.direct_addresses = Object.freeze([...event.direct_addresses])
      break
    case 'pairing':
      if (!/^[0-9]{6}$/u.test(event.code) || !Number.isSafeInteger(event.expires_in_sec) || event.expires_in_sec < 1 || event.expires_in_sec > 3600) throw new Error('invalid sidecar pairing event')
      break
    case 'pairing-closed': if (!text(event.reason, 128)) throw new Error('invalid sidecar reason'); break
    case 'peer-path':
      if (!['direct', 'relay'].includes(event.kind) || !text(event.remote, 512)) throw new Error('invalid sidecar path event')
      break
    case 'devices':
      if (!Array.isArray(event.devices) || event.devices.length > 256 || !event.devices.every((device) => exact(device, ['id', 'name', 'paired_at', 'online'])
        && endpointId(device.id) && text(device.name, 128) && text(device.paired_at, 64) && typeof device.online === 'boolean')) throw new Error('invalid sidecar device event')
      event.devices = Object.freeze(event.devices.map((device) => Object.freeze({ ...device })))
      break
    case 'error': if (!text(event.code, 128) || !text(event.message, 1024)) throw new Error('invalid sidecar error event'); break
  }
  return Object.freeze(event)
}

/** Read/create the host identity before constructing its HTTPS certificate. */
export async function resolveSidecarIdentity({ executable, dataDir, spawnImpl = spawn, timeoutMs = 15_000, stopTimeoutMs = 2000 }) {
  if (!isAbsolute(executable) || !isAbsolute(dataDir) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs < 1) throw new Error('invalid sidecar identity options')
  const child = spawnImpl(executable, ['--lang', 'en', 'id', '--data-dir', dataDir], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let output = Buffer.alloc(0), failure, terminating = false
  let killDeadline, hardDeadline
  const result = new Promise((resolve, reject) => {
    const terminate = (error) => {
      failure ??= error
      if (terminating) return
      terminating = true
      child.kill()
      killDeadline = setTimeout(() => {
        child.kill('SIGKILL')
        hardDeadline = setTimeout(() => reject(new Error('sidecar identity process did not terminate')), stopTimeoutMs)
      }, stopTimeoutMs)
    }
    const deadline = setTimeout(() => terminate(new Error('sidecar identity timeout')), timeoutMs)
    child.stdout.on('data', (chunk) => {
      if (output.length + chunk.length > 128) { terminate(new Error('sidecar identity output too large')); return }
      output = Buffer.concat([output, chunk])
    })
    child.stdout.on('error', () => terminate(new Error('sidecar identity stdout failed')))
    child.stderr?.on('error', () => {})
    child.stderr?.resume()
    child.once('error', () => terminate(new Error('sidecar identity process failed')))
    child.once('close', (code) => {
      clearTimeout(deadline); clearTimeout(killDeadline); clearTimeout(hardDeadline)
      let id
      try { id = new TextDecoder('utf-8', { fatal: true }).decode(output).trim() }
      catch { failure ??= new Error('invalid sidecar identity encoding') }
      if (failure !== undefined) reject(failure)
      else if (code !== 0 || !endpointId(id)) reject(new Error('invalid sidecar identity output'))
      else resolve(id)
    })
  })
  return result
}

const timer = (milliseconds) => {
  let id
  return { promise: new Promise((resolve) => { id = setTimeout(() => resolve(false), milliseconds) }), clear: () => clearTimeout(id) }
}

/** Own a single first-party process, including failed startup and bounded EOF. */
export class SidecarController {
  #child
  #events = []
  #listeners = new Set()
  #closed
  #stopTask
  #stopping = false
  #rejectReady
  #pending = Buffer.alloc(0)
  #protocolFailed = false

  constructor({ executable, dataDir, proxyTarget, spawnImpl = spawn, readyTimeoutMs = 15_000, stopTimeoutMs = 2_000, maxEvents = 128 }) {
    if (!isAbsolute(executable) || !isAbsolute(dataDir)) throw new Error('sidecar paths must be absolute')
    for (const limit of [readyTimeoutMs, stopTimeoutMs, maxEvents]) if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid sidecar limit')
    this.executable = executable; this.dataDir = dataDir; this.proxyTarget = validateProxyTarget(proxyTarget)
    this.spawnImpl = spawnImpl; this.readyTimeoutMs = readyTimeoutMs; this.stopTimeoutMs = stopTimeoutMs; this.maxEvents = maxEvents
  }

  get events() { return [...this.#events] }

  async start({ pair = false, localOnly = false } = {}) {
    if (this.#child !== undefined || this.#stopTask !== undefined) throw new Error('sidecar already started or stopping')
    if (typeof pair !== 'boolean' || typeof localOnly !== 'boolean') throw new Error('invalid sidecar start options')
    this.#pending = Buffer.alloc(0); this.#protocolFailed = false; this.#events = []
    const target = new URL(this.proxyTarget)
    const socketAddress = `${target.hostname}:${target.port || (target.protocol === 'https:' ? '443' : '80')}`
    const args = ['--lang', 'en', 'host', '--data-dir', this.dataDir, '--proxy-target', socketAddress]
    if (pair) args.push('--pair')
    if (localOnly) args.push('--local-only')
    let resolveReady, rejectReady
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    this.#rejectReady = rejectReady
    const child = this.spawnImpl(this.executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.#child = child
    this.#closed = new Promise((resolve) => child.once('close', (code, signal) => {
      if (this.#pending.length !== 0 && !this.#protocolFailed) this.#publish({ type: 'sidecar-protocol-error', code: 'unterminated_line' })
      this.#pending = Buffer.alloc(0)
      if (this.#child === child) this.#child = undefined
      this.#publish({ type: 'sidecar-exit', code, signal })
      rejectReady(new Error('sidecar exited before ready'))
      resolve(true)
    }))
    const remove = this.onEvent((event) => {
      if (event.type === 'ready' && !this.#stopping) resolveReady(event)
      if (event.type === 'sidecar-protocol-error' || event.type === 'sidecar-error' || event.type === 'error') rejectReady(new Error(event.code ?? 'sidecar startup failed'))
    })
    child.stdout.on('data', (chunk) => this.#consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    child.stdout.on('error', () => this.#fail('stdout_error'))
    child.stdin.on('error', () => this.#fail('stdin_error'))
    child.stderr?.on('error', () => {})
    child.stderr?.resume()
    child.once('error', () => {
      this.#publish({ type: 'sidecar-error', code: 'process_error' })
      rejectReady(new Error('sidecar process failed'))
      void this.stop().catch(() => this.#publish({ type: 'sidecar-error', code: 'termination_failed' }))
    })
    const deadline = setTimeout(() => rejectReady(new Error('sidecar ready timeout')), this.readyTimeoutMs)
    try { return await ready } catch (error) {
      await this.stop()
      throw error
    } finally { clearTimeout(deadline); remove(); this.#rejectReady = undefined }
  }

  send(message) {
    if (this.#child === undefined || this.#child.stdin.destroyed || this.#stopTask !== undefined) throw new Error('sidecar is not running')
    const encoded = encodeCommand(message)
    if ((this.#child.stdin.writableLength ?? 0) + Buffer.byteLength(encoded) > 64 * 1024) throw new Error('sidecar command buffer is full')
    return this.#child.stdin.write(encoded)
  }

  async stop() {
    if (this.#stopTask !== undefined) return this.#stopTask
    const child = this.#child
    if (child === undefined) return
    this.#stopping = true
    this.#rejectReady?.(new Error('sidecar stopped during startup'))
    this.#stopTask = (async () => {
      const wait = async () => {
        const deadline = timer(this.stopTimeoutMs)
        try { return await Promise.race([this.#closed, deadline.promise]) } finally { deadline.clear() }
      }
      if (!child.stdin.destroyed) child.stdin.end(encodeCommand({ version: 1, type: 'shutdown' }))
      if (await wait()) return
      child.kill()
      if (await wait()) return
      child.kill('SIGKILL')
      if (!await wait()) throw new Error('sidecar did not exit after termination')
    })()
    try { await this.#stopTask } finally { this.#stopTask = undefined; this.#stopping = false }
  }

  onEvent(listener) {
    if (typeof listener !== 'function') throw new Error('invalid sidecar listener')
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #fail(code) {
    if (this.#protocolFailed) return
    this.#protocolFailed = true; this.#pending = Buffer.alloc(0)
    this.#publish({ type: 'sidecar-protocol-error', code })
    void this.stop().catch(() => this.#publish({ type: 'sidecar-error', code: 'termination_failed' }))
  }

  #consume(chunk) {
    if (this.#protocolFailed) return
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset)
      const end = newline === -1 ? chunk.length : newline
      const segment = chunk.subarray(offset, end)
      if (this.#pending.length + segment.length > MAX_LINE_BYTES) { this.#fail('line_too_large'); return }
      this.#pending = Buffer.concat([this.#pending, segment])
      if (newline === -1) return
      let line
      try { line = new TextDecoder('utf-8', { fatal: true }).decode(this.#pending) }
      catch { this.#fail('invalid_utf8'); return }
      this.#pending = Buffer.alloc(0)
      let event
      try { event = decodeSidecarEvent(line) } catch { this.#fail('invalid_event'); return }
      this.#publish(event)
      offset = newline + 1
    }
  }

  #publish(event) {
    const frozen = Object.freeze(event)
    this.#events.push(frozen)
    if (this.#events.length > this.maxEvents) this.#events.splice(0, this.#events.length - this.maxEvents)
    for (const listener of this.#listeners) {
      try {
        const result = listener(frozen)
        if (result !== undefined && typeof result?.then === 'function') void Promise.resolve(result).catch(() => {})
      } catch { /* Observers do not own process cleanup. */ }
    }
  }
}

export { MAX_LINE_BYTES }
