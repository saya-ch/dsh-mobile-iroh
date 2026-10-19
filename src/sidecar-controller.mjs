import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { isAbsolute } from 'node:path'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1'])
const MAX_LINE_BYTES = 16 * 1024

const normalizeHostname = (hostname) => hostname.startsWith('[') && hostname.endsWith(']')
  ? hostname.slice(1, -1)
  : hostname

/** Validate the only kind of gateway origin a host sidecar may receive. */
export function validateProxyTarget(value) {
  const target = new URL(value)
  if (target.protocol !== 'http:' || !LOOPBACK_HOSTS.has(normalizeHostname(target.hostname))
    || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
    throw new Error('sidecar proxy target must be an explicit HTTP loopback origin')
  }
  return target.origin
}

const encodeCommand = (message) => {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) throw new Error('invalid sidecar command')
  const keys = Object.keys(message)
  if (keys.some((key) => key.length === 0 || key.length > 64)) throw new Error('invalid sidecar command')
  const line = JSON.stringify(message)
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) throw new Error('sidecar command too large')
  return `${line}\n`
}

/** Own one first-party sidecar process without exposing peer-controlled paths. */
export class SidecarController {
  #child
  #readline
  #events = []
  #listeners = new Set()

  constructor({ executable, dataDir, proxyTarget, spawnImpl = spawn }) {
    if (!isAbsolute(executable) || !isAbsolute(dataDir)) throw new Error('sidecar paths must be absolute')
    this.executable = executable
    this.dataDir = dataDir
    this.proxyTarget = validateProxyTarget(proxyTarget)
    this.spawnImpl = spawnImpl
  }

  get events() { return [...this.#events] }

  start({ pair = false } = {}) {
    if (this.#child !== undefined) throw new Error('sidecar already started')
    const args = ['--lang', 'en', 'host', '--data-dir', this.dataDir, '--proxy-target', new URL(this.proxyTarget).host]
    if (pair) args.push('--pair')
    const child = this.spawnImpl(this.executable, args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
    this.#child = child
    this.#readline = createInterface({ input: child.stdout })
    this.#readline.on('line', (line) => this.#consume(line))
    child.once('close', (code, signal) => this.#publish({ type: 'sidecar-exit', code, signal }))
    child.once('error', (error) => this.#publish({ type: 'sidecar-error', message: error.message }))
  }

  send(message) {
    if (this.#child === undefined || this.#child.stdin.destroyed) throw new Error('sidecar is not running')
    this.#child.stdin.write(encodeCommand(message))
  }

  async stop() {
    const child = this.#child
    this.#child = undefined
    this.#readline?.close()
    this.#readline = undefined
    if (child === undefined || child.exitCode !== null) return
    child.stdin.end()
    child.kill()
    await new Promise((resolve) => child.once('close', resolve))
  }

  onEvent(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #consume(line) {
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      this.#publish({ type: 'sidecar-protocol-error', code: 'line_too_large' })
      void this.stop()
      return
    }
    try {
      const event = JSON.parse(line)
      if (event === null || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') throw new Error('invalid event')
      this.#publish(event)
    } catch {
      this.#publish({ type: 'sidecar-protocol-error', code: 'invalid_json' })
      void this.stop()
    }
  }

  #publish(event) {
    this.#events.push(Object.freeze(event))
    for (const listener of this.#listeners) listener(event)
  }
}

export { encodeCommand }
