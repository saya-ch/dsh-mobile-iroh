import { validateProxyTarget } from './sidecar-controller.mjs'

const fail = (errors, message) => {
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, message)
}

/**
 * Independent prototype of DSH Mobile's provider lifecycle. Both factories are
 * supplied by the owning plugin: this module neither imports nor mutates DSH.
 * The gateway owns per-device HTTP authentication and its HTTPS certificate;
 * the sidecar carries TLS bytes, without injecting cookies or rewriting Origin.
 */
export class IrohRemoteController {
  #initialized = false
  #closing = false
  #enabled = false
  #queue = Promise.resolve()
  #closeTask
  #gateway
  #sidecar
  #unsubscribe
  #generation = 0
  #latest = Object.freeze({ enabled: false, state: 'off' })

  constructor({ store, resolveEndpointId, createGateway, createSidecar, onStatus, localOnly = false, localPort = 25443 }) {
    if (typeof store?.load !== 'function' || typeof store?.save !== 'function'
      || typeof resolveEndpointId !== 'function' || typeof createGateway !== 'function' || typeof createSidecar !== 'function'
      || typeof localOnly !== 'boolean' || !Number.isSafeInteger(localPort) || localPort < 1024 || localPort > 65535) throw new Error('invalid iroh provider dependencies')
    this.store = store; this.resolveEndpointId = resolveEndpointId; this.createGateway = createGateway; this.createSidecar = createSidecar
    this.onStatus = onStatus; this.localOnly = localOnly; this.localPort = localPort
  }

  status() { return this.#latest }
  gateway() { return this.#gateway }

  async initialize(initialState) {
    if (this.#closing) throw new Error('iroh_provider_closed')
    return this.#enqueue(async () => {
      if (this.#closing) throw new Error('iroh_provider_closed')
      if (this.#initialized) return
      const saved = initialState ?? await this.store.load()
      if (saved?.version !== 1 || typeof saved.enabled !== 'boolean') throw new Error('invalid iroh provider state')
      this.#enabled = saved.enabled
      this.#initialized = true
      if (this.#enabled) await this.#start()
      else this.#publish({ enabled: false, state: 'off' })
    })
  }

  async setEnabled(enabled) {
    this.#assertAvailable()
    if (typeof enabled !== 'boolean') throw new Error('invalid iroh provider switch')
    await this.#enqueue(async () => {
      this.#assertAvailable()
      if (enabled === this.#enabled && (!enabled || this.#latest.state === 'ready')) return
      try {
        await this.#stop()
        await this.store.save({ version: 1, enabled })
      } catch (error) {
        this.#publish({ enabled: this.#enabled, state: 'error', errorCode: 'iroh_switch_failed' })
        throw error
      }
      this.#enabled = enabled
      if (enabled) await this.#start()
      else this.#publish({ enabled: false, state: 'off' })
    })
    return this.status()
  }

  async reconnect() {
    this.#assertAvailable()
    await this.#enqueue(async () => {
      this.#assertAvailable()
      await this.#stop()
      if (!this.#enabled) await this.store.save({ version: 1, enabled: true })
      this.#enabled = true
      await this.#start()
    })
    return this.status()
  }

  async reset() { return this.setEnabled(false) }

  /** Invalidate late startup before waiting for the serialized cleanup. */
  close() {
    this.#closing = true
    this.#generation += 1
    this.#closeTask ??= this.#enqueue(async () => {
      await this.#stop()
      this.#publish({ enabled: this.#enabled, state: 'off' })
    }).catch((error) => { this.#closeTask = undefined; throw error })
    return this.#closeTask
  }

  #assertAvailable() {
    if (!this.#initialized || this.#closing) throw new Error('iroh_provider_closed')
  }

  #enqueue(operation) {
    const task = this.#queue.then(operation, operation)
    this.#queue = task.then(() => undefined, () => undefined)
    return task
  }

  #publish(status) {
    this.#latest = Object.freeze({ ...status })
    try {
      const result = this.onStatus?.(this.#latest)
      if (result !== undefined && typeof result?.then === 'function') void Promise.resolve(result).catch(() => {})
    } catch { /* Status observers cannot retain resources. */ }
  }

  async #start() {
    if (this.#closing) return
    const generation = ++this.#generation
    this.#publish({ enabled: true, state: 'starting' })
    try {
      const expectedId = await this.resolveEndpointId()
      if (!/^[0-9a-f]{64}$/u.test(expectedId)) throw new Error('invalid iroh endpoint identity')
      if (this.#closing || generation !== this.#generation) return
      let gateway
      try { gateway = await this.createGateway({ endpointId: expectedId }) }
      catch (error) {
        // A trusted factory can fail after creating a listener whose close also
        // failed. Retain that cleanup owner until a later close actually succeeds.
        if (typeof error?.gatewayCleanup?.close === 'function') this.#gateway = error.gatewayCleanup
        throw error
      }
      this.#gateway = gateway
      if (typeof gateway?.close !== 'function') throw new Error('invalid iroh gateway')
      if (this.#closing || generation !== this.#generation) { await this.#stop(); return }
      const proxyTarget = validateProxyTarget(gateway.proxyTarget ?? gateway.address().origin)
      const advertised = new URL(gateway.advertisedOrigin)
      if (advertised.protocol !== 'https:' || advertised.pathname !== '/' || advertised.username || advertised.password || advertised.search || advertised.hash) throw new Error('invalid iroh advertised origin')
      const sidecar = await this.createSidecar({ proxyTarget })
      this.#sidecar = sidecar
      if (typeof sidecar?.start !== 'function' || typeof sidecar?.stop !== 'function' || typeof sidecar?.onEvent !== 'function') throw new Error('invalid iroh sidecar')
      if (this.#closing || generation !== this.#generation) { await this.#stop(); return }
      this.#unsubscribe = sidecar.onEvent((event) => {
        if (this.#closing || generation !== this.#generation) return
        if (event.type === 'sidecar-exit' || event.type === 'sidecar-error' || event.type === 'sidecar-protocol-error' || event.type === 'error') {
          const cleanupGeneration = ++this.#generation
          this.#publish({ enabled: this.#enabled, state: 'error', errorCode: 'iroh_sidecar_stopped' })
          void this.#enqueue(async () => {
            if (cleanupGeneration !== this.#generation) return
            await this.#stop()
          }).catch(() => this.#publish({ enabled: this.#enabled, state: 'error', errorCode: 'iroh_cleanup_failed' }))
        }
      })
      const ready = await sidecar.start({ localOnly: this.localOnly })
      if (this.#closing || generation !== this.#generation) { await this.#stop(); return }
      if (ready.endpoint_id !== expectedId) throw new Error('iroh sidecar identity changed during startup')
      const hostname = `${ready.endpoint_id.slice(0, 32)}.${ready.endpoint_id.slice(32)}.iroh.localhost`
      if (advertised.origin !== `https://${hostname}:${this.localPort}`) throw new Error('iroh advertised origin does not match endpoint identity and local port')
      this.#publish({ enabled: true, state: 'ready', origin: advertised.origin, backendOrigin: proxyTarget, endpointId: ready.endpoint_id })
    } catch (error) {
      const failures = [error]
      try { await this.#stop() } catch (cleanup) { failures.push(cleanup) }
      this.#publish({ enabled: this.#enabled, state: 'error', errorCode: failures.length > 1 ? 'iroh_cleanup_failed' : 'iroh_start_failed' })
      fail(failures, 'iroh startup and cleanup failed')
    }
  }

  async #stop() {
    this.#generation += 1
    this.#unsubscribe?.(); this.#unsubscribe = undefined
    // Do not close the gateway while its consumer may still accept streams.
    if (this.#sidecar !== undefined) {
      await this.#sidecar.stop()
      this.#sidecar = undefined
    }
    if (this.#gateway !== undefined) {
      await this.#gateway.close()
      this.#gateway = undefined
    }
  }
}
