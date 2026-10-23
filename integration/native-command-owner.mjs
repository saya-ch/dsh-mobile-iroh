import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'

/** Bounded native commands for trusted fixed-path adapters; actual close releases ownership. */
export class NativeCommandOwner {
  #options
  #queue = Promise.resolve()
  #active
  #closed = false
  #closeTask
  constructor({ executable, dataDirectory, fault, prefix, maxOutputBytes, timeoutMs = 5000, stopTimeoutMs = 2000, spawnImpl = spawn }) {
    if (!isAbsolute(executable ?? '') || !isAbsolute(dataDirectory ?? '') || typeof spawnImpl !== 'function'
      || typeof fault !== 'function' || !/^[a-z_]+$/u.test(prefix) || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1
      || [timeoutMs,stopTimeoutMs].some(value => !Number.isSafeInteger(value) || value < 1 || value > 60000)) throw fault(`invalid_${prefix}_store_options`)
    this.#options = { executable,dataDirectory,fault,prefix,maxOutputBytes,timeoutMs,stopTimeoutMs,spawnImpl }
  }
  /** Serialize adapter-owned arguments and validate one canonical response, without replay. */
  run(command,args,decode,{ signal } = {}) {
    const { fault,prefix } = this.#options
    if (signal !== undefined && !(signal instanceof AbortSignal)) return Promise.reject(fault(`invalid_${prefix}_signal`))
    if (this.#closed) return Promise.reject(fault(`${prefix}_store_closed`))
    const run = () => {
      if (this.#closed) throw fault(`${prefix}_store_closed`)
      if (signal?.aborted) throw fault(`${prefix}_operation_cancelled`)
      if (this.#active) throw fault(`${prefix}_process_not_closed`)
      return this.#command(command,args,decode,signal)
    }
    const task = this.#queue.then(run,run)
    this.#queue = task.then(() => undefined,() => undefined)
    return task
  }
  /** Cancel work and retain failed child owners for explicit close retry. */
  close() {
    if (this.#closeTask) return this.#closeTask
    this.#closed = true
    const { fault,prefix } = this.#options
    const stopping = this.#active?.cancel(`${prefix}_store_closed`)
    this.#closeTask = (async () => {
      const results = await Promise.allSettled([this.#queue,stopping])
      if (this.#active || results.some(result => result.status === 'rejected')) throw fault(`${prefix}_process_not_closed`)
    })().catch(error => { this.#closeTask = undefined; throw error })
    return this.#closeTask
  }
  #command(command,args,decode,signal) {
    const { executable,dataDirectory,fault,prefix,maxOutputBytes,timeoutMs,stopTimeoutMs,spawnImpl } = this.#options
    let child
    try { child = spawnImpl(executable,['--lang','en',command,'--data-dir',dataDirectory,...args],{ stdio:['ignore','pipe','pipe'],windowsHide:true }) }
    catch { throw fault(`${prefix}_process_failed`) }
    let output = Buffer.alloc(0),stderrBytes = 0,failed,closed = false,settled = false,stopTask,deadline
    let resolveClosed
    const actualClose = new Promise(resolve => { resolveClosed = resolve })
    const waitForClose = async () => {
      let timer
      try { return await Promise.race([actualClose.then(() => true),new Promise(resolve => { timer = setTimeout(() => resolve(false),stopTimeoutMs) })]) }
      finally { clearTimeout(timer) }
    }
    const stop = () => {
      if (stopTask) return stopTask
      stopTask = (async () => {
        if (closed) return
        try { child.kill() } catch { /* Actual close, not kill, releases ownership. */ }
        if (await waitForClose()) return
        try { child.kill('SIGKILL') } catch { /* Failed termination remains owned. */ }
        if (!await waitForClose()) throw fault(`${prefix}_process_not_closed`)
      })().catch(error => { stopTask = undefined; throw error })
      return stopTask
    }
    return new Promise((resolve,reject) => {
      const settle = (error,value) => {
        if (settled) return
        settled = true; clearTimeout(deadline); signal?.removeEventListener('abort',abort)
        if (error) reject(error); else resolve(value)
      }
      const fail = code => { failed ??= fault(code); return stop().catch(() => settle(fault(`${prefix}_process_not_closed`))) }
      const abort = () => { void fail(`${prefix}_operation_cancelled`) }
      const owner = { cancel:code => { failed ??= fault(code); return stop() } }
      this.#active = owner
      child.once('close',(exitCode,exitSignal) => {
        if (closed) return
        closed = true; resolveClosed()
        if (this.#active === owner) this.#active = undefined
        if (failed) { settle(failed); return }
        if (exitCode !== 0 || exitSignal !== null) { settle(fault(`${prefix}_process_failed`)); return }
        try { settle(undefined,decode(new TextDecoder('utf-8',{ fatal:true }).decode(output))) }
        catch { settle(fault(`invalid_${prefix}_response`)) }
      })
      child.once('error',() => { void fail(`${prefix}_process_failed`) })
      child.stdout.on('error',() => { void fail(`${prefix}_process_failed`) })
      child.stderr.on('error',() => { void fail(`${prefix}_process_failed`) })
      child.stderr.on('data',chunk => { stderrBytes += Buffer.byteLength(chunk); if (stderrBytes > maxOutputBytes) void fail(`${prefix}_output_too_large`) })
      child.stdout.on('data',chunk => {
        if (failed) return
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (output.length + bytes.length > maxOutputBytes) { void fail(`${prefix}_output_too_large`); return }
        output = Buffer.concat([output,bytes])
      })
      deadline = setTimeout(() => { void fail(`${prefix}_operation_timeout`) },timeoutMs)
      signal?.addEventListener('abort',abort,{ once:true })
      if (signal?.aborted) abort()
    })
  }
}
