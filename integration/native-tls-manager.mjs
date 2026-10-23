import { spawn } from 'node:child_process'
import { isAbsolute, join } from 'node:path'
import { irohHostname } from './origin-contract.mjs'

const MAX_OUTPUT_BYTES = 8192
const METADATA_KEYS = 'caFingerprint256,caValidTo,endpointId,hostname,instanceId,leafFingerprint256,leafValidTo,tls,version'
const fingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Redacted failures do not contain native stderr, arguments, keys or paths. */
export class NativeTlsError extends Error {
  constructor(code) { super(code); this.name = 'NativeTlsError'; this.code = code }
}
const fault = code => new NativeTlsError(code)

function validateMetadata(value, dataDirectory, endpointId) {
  if (!plain(value) || Object.keys(value).sort().join(',') !== METADATA_KEYS || value.version !== 1
    || !fingerprint(value.endpointId) || endpointId !== undefined && value.endpointId !== endpointId
    || value.hostname !== irohHostname(value.endpointId)
    || !fingerprint(value.caFingerprint256) || !fingerprint(value.leafFingerprint256)
    || value.instanceId !== value.caFingerprint256
    || !Number.isSafeInteger(value.caValidTo) || !Number.isSafeInteger(value.leafValidTo)
    || value.leafValidTo <= 0 || value.leafValidTo > value.caValidTo
    || !plain(value.tls) || Object.keys(value.tls).sort().join(',') !== 'caFile,certFile,keyFile'
    || value.tls.caFile !== join(dataDirectory, 'tls', 'ca.pem')
    || value.tls.certFile !== join(dataDirectory, 'tls', 'server.pem')
    || value.tls.keyFile !== join(dataDirectory, 'tls', 'server-key.pem')) throw fault('invalid_tls_response')
  return Object.freeze({ ...value, tls: Object.freeze({ ...value.tls }) })
}

/**
 * Fixed native TLS owner. It serializes prepare/renew, rejects unknown responses,
 * and retains a subprocess until actual close. Private keys never enter Node.
 * Gateway refresh and renewal scheduling belong to the Gateway owner, not this store.
 */
export class NativeTlsManager {
  #options
  #queue = Promise.resolve()
  #active
  #closed = false
  #closeTask
  #metadata
  #errorCode

  constructor({ executable, dataDirectory, leafValidityDays = 90, renewBeforeDays = 30,
    timeoutMs = 15000, stopTimeoutMs = 2000, spawnImpl = spawn }) {
    if (!isAbsolute(executable ?? '') || !isAbsolute(dataDirectory ?? '') || typeof spawnImpl !== 'function'
      || [timeoutMs, stopTimeoutMs].some(value => !Number.isSafeInteger(value) || value < 1 || value > 60000)
      || !Number.isSafeInteger(leafValidityDays) || leafValidityDays < 2 || leafValidityDays > 365
      || !Number.isSafeInteger(renewBeforeDays) || renewBeforeDays < 1 || renewBeforeDays >= leafValidityDays) {
      throw fault('invalid_tls_manager_options')
    }
    this.#options = Object.freeze({ executable, dataDirectory, leafValidityDays, renewBeforeDays, timeoutMs, stopTimeoutMs, spawnImpl })
  }

  /** Prepare durable CA/leaf state, renewing an intact leaf before its configured deadline. */
  prepare({ endpointId, signal } = {}) { return this.#enqueue('tls-prepare', endpointId, signal) }

  /** Explicitly issue a new leaf under the existing CA; a cancelled commit is not rolled back. */
  renew({ endpointId, signal } = {}) { return this.#enqueue('tls-renew', endpointId, signal) }

  /** Install prepared material while the native lease excludes every other native TLS writer. */
  withPrepared({ endpointId, signal } = {}, activate) {
    if (typeof activate !== 'function') return Promise.reject(fault('invalid_tls_activation'))
    return this.#enqueue('tls-prepare', endpointId, signal, activate)
  }

  /** Install a new leaf before releasing its native lease; callback observes cancellation. */
  withRenewed({ endpointId, signal } = {}, activate) {
    if (typeof activate !== 'function') return Promise.reject(fault('invalid_tls_activation'))
    return this.#enqueue('tls-renew', endpointId, signal, activate)
  }

  /** Inspect complete native state without generating or renewing a certificate. */
  inspect({ endpointId, signal } = {}) { return this.#enqueue('tls-status', endpointId, signal) }

  /** Safe cached disk metadata only; the Gateway separately reports its active TLS context. */
  status() {
    const { tls: _paths, version: _version, ...safe } = this.#metadata ?? {}
    return Object.freeze({ state: this.#closed ? 'closed' : this.#errorCode ? 'error' : this.#metadata ? 'ready' : 'unprepared',
      ...safe, ...(this.#errorCode === undefined ? {} : { errorCode: this.#errorCode }) })
  }

  /** Cancel accepted work, waiting for child close; failed cleanup is retryable. */
  close() {
    if (this.#closeTask !== undefined) return this.#closeTask
    this.#closed = true
    const stopping = this.#active?.cancel('tls_manager_closed')
    this.#closeTask = (async () => {
      const results = await Promise.allSettled([this.#queue, stopping])
      if (this.#active !== undefined || results.some(result => result.status === 'rejected')) throw fault('tls_process_not_closed')
    })().catch(error => { this.#closeTask = undefined; throw error })
    return this.#closeTask
  }

  #enqueue(command, endpointId, signal, activate) {
    if (signal !== undefined && !(signal instanceof AbortSignal)
      || endpointId !== undefined && !fingerprint(endpointId)) return Promise.reject(fault('invalid_tls_request'))
    if (this.#closed) return Promise.reject(fault('tls_manager_closed'))
    const run = () => {
      if (this.#closed) throw fault('tls_manager_closed')
      if (signal?.aborted) throw fault('tls_operation_cancelled')
      if (this.#active !== undefined) throw fault('tls_process_not_closed')
      return this.#command(command, endpointId, signal, activate)
    }
    const task = this.#queue.then(run, run).then(({ metadata, result }) => {
      this.#metadata = metadata; this.#errorCode = undefined; return activate === undefined ? metadata : result
    }, error => { this.#errorCode = error.code ?? 'tls_process_failed'; throw error })
    this.#queue = task.then(() => undefined, () => undefined)
    return task
  }

  #command(command, endpointId, signal, activate) {
    const { executable, dataDirectory, leafValidityDays, renewBeforeDays, timeoutMs, stopTimeoutMs, spawnImpl } = this.#options
    const args = ['--lang', 'en', command, '--data-dir', dataDirectory]
    if (command !== 'tls-status') args.push('--leaf-validity-days', String(leafValidityDays), '--renew-before-days', String(renewBeforeDays))
    if (activate !== undefined) args.push('--hold')
    let child
    try { child = spawnImpl(executable, args, { stdio: [activate === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true }) }
    catch { throw fault('tls_process_failed') }
    let output = Buffer.alloc(0), stderrBytes = 0, failed, closed = false, settled = false, stopTask, deadline
    let heldMetadata, activationTask, activationResult, released = false
    const activationAbort = new AbortController()
    let resolveClosed
    const actualClose = new Promise(resolve => { resolveClosed = resolve })
    const waitForClose = async () => {
      let timer
      try { return await Promise.race([actualClose.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), stopTimeoutMs) })]) }
      finally { clearTimeout(timer) }
    }
    const stop = () => {
      if (stopTask !== undefined) return stopTask
      stopTask = (async () => {
        if (closed) return
        try { child.kill() } catch { /* Only close releases ownership. */ }
        if (await waitForClose()) return
        try { child.kill('SIGKILL') } catch { /* Failed termination remains owned. */ }
        if (!await waitForClose()) throw fault('tls_process_not_closed')
      })().catch(error => { stopTask = undefined; throw error })
      return stopTask
    }
    return new Promise((resolve, reject) => {
      const settle = (error, value) => {
        if (settled) return
        settled = true; clearTimeout(deadline); signal?.removeEventListener('abort', abort)
        if (error !== undefined) reject(error)
        else resolve(value)
      }
      const fail = code => {
        failed ??= fault(code)
        activationAbort.abort()
        return stop().catch(() => settle(fault('tls_process_not_closed')))
      }
      const abort = () => { void fail('tls_operation_cancelled') }
      const owner = { cancel: code => { failed ??= fault(code); activationAbort.abort(); return stop() } }
      this.#active = owner
      child.once('close', (exitCode, exitSignal) => {
        if (closed) return
        closed = true; resolveClosed()
        if (activate !== undefined && !released || exitCode !== 0 || exitSignal !== null) {
          failed ??= fault('tls_process_failed'); activationAbort.abort()
        }
        // A callback must drain before ownership is released, even after an
        // unexpected native exit. Its signal forbids late Gateway publication.
        void Promise.resolve(activationTask).catch(() => {}).then(() => {
          if (this.#active === owner) this.#active = undefined
          if (failed !== undefined) { settle(failed); return }
          try {
            const metadata = decodeMetadata()
            settle(undefined, { metadata, result: activationResult })
          } catch { settle(fault('invalid_tls_response')) }
        })
      })
      const decodeMetadata = () => {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(output)
        const value = JSON.parse(text)
        if (text !== `${JSON.stringify(value)}\n`) throw fault('invalid_tls_response')
        return validateMetadata(value, dataDirectory, endpointId)
      }
      child.once('error', () => { void fail('tls_process_failed') })
      child.stdout.on('error', () => { void fail('tls_process_failed') })
      child.stderr.on('error', () => { void fail('tls_process_failed') })
      child.stdin?.on('error', () => { void fail('tls_process_failed') })
      child.stderr.on('data', chunk => {
        stderrBytes += Buffer.byteLength(chunk)
        if (stderrBytes > MAX_OUTPUT_BYTES) void fail('tls_output_too_large')
      })
      child.stdout.on('data', chunk => {
        if (failed !== undefined) return
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (output.length + bytes.length > MAX_OUTPUT_BYTES) { void fail('tls_output_too_large'); return }
        output = Buffer.concat([output, bytes])
        if (activate !== undefined && heldMetadata === undefined && output.includes(10)) {
          try { heldMetadata = decodeMetadata() }
          catch { void fail('invalid_tls_response'); return }
          activationTask = Promise.resolve().then(() => {
            if (failed !== undefined || closed || activationAbort.signal.aborted) throw fault('tls_operation_cancelled')
            return activate(heldMetadata, activationAbort.signal)
          }).then(result => {
            if (failed !== undefined || closed || activationAbort.signal.aborted) throw fault('tls_operation_cancelled')
            activationResult = result; released = true
            child.stdin.end('{"version":1,"type":"tls-release"}\n')
          }).catch(() => { void fail('tls_activation_failed') })
        } else if (heldMetadata !== undefined) void fail('invalid_tls_response')
      })
      deadline = setTimeout(() => { void fail('tls_operation_timeout') }, timeoutMs)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  }
}
