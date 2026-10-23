import { isAbsolute, join } from 'node:path'
import { IrohRemoteController } from '../src/iroh-remote-controller.mjs'
import { resolveSidecarIdentity, SidecarController } from '../src/sidecar-controller.mjs'
import { createIrohGatewayFactory } from './mobile-gateway-factory.mjs'
import { DEFAULT_IROH_LOCAL_PORT } from './origin-contract.mjs'
import { encodePairingDescriptor, MAX_PAIRING_LIFETIME_MS, validatePairingDescriptor } from './pairing-descriptor.mjs'

const ENDPOINT_ID = /^[a-f0-9]{64}$/u

/** Fixed operator errors deliberately omit pairing material and nested causes. */
export class HostOperatorError extends Error {
  constructor(code) { super(code); this.name = 'HostOperatorError'; this.code = code }
}
const fault = (code) => new HostOperatorError(code)

/**
 * Trusted in-process Host entry. It adds no operator/admin HTTP route, browser
 * bridge or model tool. It must be the sidecar's sole stdio command owner.
 * The injected preference store owns persistence;
 * this module never guesses an install profile or rewrites corrupt state.
 */
export class IrohHostSession {
  #options
  #controller
  #sidecar
  #identityTask
  #initialized = false
  #mustRetire = false
  #stopped = true
  #closed = false
  #generation = 0
  #queue = Promise.resolve()
  #startTask
  #restoreTask
  #reconnectTask
  #stopTask
  #closeTask
  #pairingBusy = false
  #cancelWait
  #errorCode
  #disabledOverride = false
  #preferenceAbort = new AbortController()

  constructor({ mobile, executable, dataDirectory, upstreamOrigin, upstreamAuthenticatedUrl, tls, tlsManager, extensionHost,
    tlsCheckIntervalMs, tlsRenewBeforeMs,
    store, localPort = DEFAULT_IROH_LOCAL_PORT, backendHost = '127.0.0.1', localOnly = false,
    commandTimeoutMs = 5000, now = () => Date.now(), onStatus,
    resolveIdentity = resolveSidecarIdentity,
    gatewayFactory = (options) => createIrohGatewayFactory(options)(),
    sidecarFactory = (options) => new SidecarController(options),
  }) {
    if (!isAbsolute(executable ?? '') || !isAbsolute(dataDirectory ?? '')
      || typeof store?.load !== 'function' || typeof store?.save !== 'function'
      || !Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs < 1 || commandTimeoutMs > 60000
      || !Number.isSafeInteger(localPort) || localPort < 1024 || localPort > 65535
      || typeof resolveIdentity !== 'function' || typeof gatewayFactory !== 'function'
      || typeof sidecarFactory !== 'function' || typeof now !== 'function') throw fault('invalid_host_operator_options')
    this.#options = Object.freeze({ mobile, executable, dataDirectory, upstreamOrigin, upstreamAuthenticatedUrl, tls, tlsManager, extensionHost,
      tlsCheckIntervalMs, tlsRenewBeforeMs,
      store, localPort, backendHost, localOnly, commandTimeoutMs, now, onStatus, resolveIdentity, gatewayFactory, sidecarFactory })
    this.#controller = this.#makeController()
  }

  /** Safe display metadata only; QR secrets are never included. */
  status() {
    const raw = this.#controller.status()
    const status = this.#disabledOverride ? { enabled: false, state: 'off' } : raw
    if (this.#errorCode !== undefined) return Object.freeze({ ...status, state: 'error', errorCode: this.#errorCode })
    if (this.#closed) return Object.freeze({ enabled: status.enabled, state: 'off' })
    return status
  }

  /** Explicitly start, or explicitly recover after an uncertain control outcome. */
  start() {
    if (this.#closed) return Promise.reject(fault('host_operator_closed'))
    if (this.#startTask !== undefined) return this.#startTask
    this.#startTask = this.#activate(true).finally(() => { this.#startTask = undefined })
    return this.#startTask
  }

  /** Restore the durable startup choice without enabling a previously disabled Host. */
  restore() {
    if (this.#closed) return Promise.reject(fault('host_operator_closed'))
    if (this.#restoreTask !== undefined) return this.#restoreTask
    this.#restoreTask = this.#activate(false).finally(() => { this.#restoreTask = undefined })
    return this.#restoreTask
  }

  /** Explicitly replace the runtime while retaining its durable identity and enabled intent. */
  reconnect() {
    if (this.#closed) return Promise.reject(fault('host_operator_closed'))
    if (this.#reconnectTask !== undefined) return this.#reconnectTask
    this.#invalidate(); this.#stopped = true; this.#mustRetire = true
    this.#reconnectTask = this.#activate(true).finally(() => { this.#reconnectTask = undefined })
    return this.#reconnectTask
  }

  /** Safe metadata for the certificate currently served, not private material paths. */
  tlsStatus() { return this.#controller.gateway()?.tlsStatus?.() ?? this.#options.tlsManager?.status() }

  /** Renew the provided leaf without retiring active transport or HTTP Sessions on failure. */
  renewTls({ signal } = {}) {
    if (this.#closed) return Promise.reject(fault('host_operator_closed'))
    const generation = this.#generation
    return this.#enqueue(async () => {
      try {
        signal?.throwIfAborted()
        const { gateway } = this.#running(generation)
        if (typeof gateway.renewTls !== 'function') throw fault('host_operator_tls_unavailable')
        const result = await gateway.renewTls({ signal })
        this.#check(generation); signal?.throwIfAborted()
        return result
      } catch (error) {
        if (error instanceof HostOperatorError) throw error
        throw fault(signal?.aborted || generation !== this.#generation ? 'host_operator_cancelled' : 'host_operator_tls_renew_failed')
      }
    })
  }

  #activate(enable) {
    const generation = this.#generation
    return this.#enqueue(async () => {
      try {
        this.#check(generation)
        if (this.#mustRetire) {
          await this.#retire()
          this.#check(generation)
          this.#controller = this.#makeController(); this.#initialized = false; this.#sidecar = undefined
          this.#mustRetire = false
        }
        this.#errorCode = undefined
        this.#disabledOverride = false
        await this.#prepareIdentity()
        this.#check(generation)
        if (!this.#initialized) {
          const state = await this.#loadState()
          this.#check(generation)
          await this.#controller.initialize(state)
          this.#initialized = true
        }
        this.#check(generation)
        if (enable) {
          if (this.#controller.status().state === 'error') await this.#controller.reconnect()
          else await this.#controller.setEnabled(true)
        }
        this.#check(generation)
        const state = this.#controller.status().state
        if (state !== 'ready' && (enable || state !== 'off')) throw fault('host_operator_not_ready')
        this.#stopped = state !== 'ready'
        return this.status()
      } catch (error) { return this.#failOperation(error, generation, enable ? 'host_operator_start_failed' : 'host_operator_restore_failed') }
    })
  }

  /** Disable durably without deleting identity, peers, or Mobile device records. */
  stop() {
    if (this.#closed) return Promise.reject(fault('host_operator_closed'))
    if (this.#stopTask !== undefined) return this.#stopTask
    this.#invalidate(); this.#stopped = true
    const generation = this.#generation
    this.#stopTask = this.#enqueue(async () => {
      try {
        this.#check(generation)
        await this.#prepareIdentity()
        this.#check(generation)
        let invalidState = false
        try { await this.#loadState() } catch { invalidState = true }
        await this.#retire()
        this.#check(generation)
        if (invalidState) throw fault('invalid_host_operator_state')
        await this.#saveState({ version: 1, enabled: false })
        this.#check(generation)
        this.#disabledOverride = true
        this.#errorCode = undefined
        this.#notify()
        return Object.freeze({ enabled: false, state: 'off' })
      } catch { this.#errorCode = 'host_operator_stop_failed'; this.#notify(); throw fault(this.#errorCode) }
    }).finally(() => { this.#stopTask = undefined })
    return this.#stopTask
  }

  /** Terminal unload, retaining the durable enabled preference for the owner. */
  close() {
    if (this.#closeTask !== undefined) return this.#closeTask
    this.#closed = true; this.#stopped = true; this.#invalidate()
    // Close the provider now, rather than waiting behind a pending QR response.
    const closing = this.#retire()
    this.#closeTask = (async () => {
      const results = await Promise.allSettled([closing, this.#queue])
      if (results.some((result) => result.status === 'rejected')) throw fault('host_operator_cleanup_failed')
      this.#errorCode = undefined
      this.#notify()
    })().catch((error) => {
      this.#closeTask = undefined; this.#errorCode = 'host_operator_cleanup_failed'; this.#notify(); throw error
    })
    return this.#closeTask
  }

  /**
   * Return one fresh QR only to a trusted operator caller. Concurrent requests
   * are rejected instead of silently replacing another caller's one-time QR.
   * Failed/uncertain operations are never retried or replayed automatically.
   */
  openPairing() {
    if (this.#closed) return Promise.reject(fault('host_operator_closed'))
    if (this.#pairingBusy) return Promise.reject(fault('host_operator_pairing_busy'))
    this.#pairingBusy = true
    const generation = this.#generation
    return this.#enqueue(async () => {
      try {
        const { sidecar, gateway } = this.#running(generation)
        // Ready and the automatic startup pairing may arrive in separate stdout
        // chunks. A FIFO device-list barrier drains that startup event before
        // subscribing for this operation's pairing-begin response.
        await this.#freshEvent(sidecar, { version: 1, type: 'device-list' }, (event) => event.type === 'devices', generation)
        this.#running(generation)
        const requestedAt = this.#options.now()
        const pairing = await this.#freshEvent(sidecar, { version: 1, type: 'pairing-begin' }, (event) => event.type === 'pairing', generation)
        this.#running(generation)
        const mobilePair = await this.#bounded(Promise.resolve().then(() => gateway.gateway.access.openPairing()), generation)
        this.#running(generation)
        const now = this.#options.now()
        const descriptor = validatePairingDescriptor({
          version: 1, type: 'dsh-mobile-iroh-pairing', endpointId: this.#controller.status().endpointId,
          origin: gateway.advertisedOrigin, localPort: this.#options.localPort,
          irohCode: pairing.code, gatewayToken: mobilePair.token, caCertificate: gateway.caCertificate,
          instanceId: gateway.instanceId,
          expiresAt: Math.min(mobilePair.expiresAt, requestedAt + pairing.expires_in_sec * 1000, requestedAt + MAX_PAIRING_LIFETIME_MS),
        }, { now })
        this.#check(generation)
        return Object.freeze({ descriptor, qrPayload: encodePairingDescriptor(descriptor, { now }) })
      } catch (error) { return this.#failOperation(error, generation, 'host_operator_pairing_failed') }
    }).finally(() => { this.#pairingBusy = false })
  }

  /** Invalidate the displayed QR by replacing both one-time windows without exposing new secrets. */
  cancelPairing() {
    if (this.#closed) return Promise.reject(fault('host_operator_closed'))
    const generation = this.#generation
    return this.#enqueue(async () => {
      try {
        const { sidecar, gateway } = this.#running(generation)
        await this.#freshEvent(sidecar, { version: 1, type: 'pairing-begin' }, event => event.type === 'pairing', generation)
        this.#running(generation)
        await this.#bounded(Promise.resolve().then(() => gateway.gateway.access.openPairing()), generation)
        this.#running(generation)
        return Object.freeze({ cancelled: true })
      } catch (error) { return this.#failOperation(error, generation, 'host_operator_pairing_failed') }
    })
  }

  /** List transport peers, not DSH Sessions or Mobile persistent credentials. */
  listPeers() {
    return this.#peerOperation({ version: 1, type: 'device-list' }, () => true)
  }

  /** Revoke the selected transport peer and close its transport connections. */
  forgetPeer(id) {
    if (typeof id !== 'string' || !ENDPOINT_ID.test(id)) return Promise.reject(fault('invalid_host_operator_peer'))
    return this.#peerOperation({ version: 1, type: 'device-forget', id }, (devices) => !devices.some((peer) => peer.id === id))
  }

  #peerOperation(command, accepts) {
    if (this.#closed) return Promise.reject(fault('host_operator_closed'))
    const generation = this.#generation
    return this.#enqueue(async () => {
      try {
        const { sidecar } = this.#running(generation)
        const event = await this.#freshEvent(sidecar, command, (event) => event.type === 'devices' && accepts(event.devices), generation)
        this.#running(generation)
        return Object.freeze(event.devices.map(({ id, name, paired_at, online }) => Object.freeze({ id, name, paired_at, online })))
      } catch (error) {
        if (command.type === 'device-list' && !this.#closed && generation === this.#generation
          && !this.#mustRetire && this.#controller.status().state === 'ready'
          && error instanceof HostOperatorError && ['host_operator_command_timeout', 'host_operator_command_failed'].includes(error.code)) {
          // The uncorrelated control stream cannot safely accept another
          // operation after a late reply, but a read-only query did not revoke
          // an active phone. Keep its data path until explicit recovery/stop.
          this.#mustRetire = true; this.#errorCode = 'host_operator_control_uncertain'; this.#notify()
          throw fault(this.#errorCode)
        }
        return this.#failOperation(error, generation, 'host_operator_peer_operation_failed')
      }
    })
  }

  #makeController() {
    let controller
    controller = new IrohRemoteController({
      store: { load: () => this.#loadState(), save: (state) => this.#saveState(state) },
      localOnly: this.#options.localOnly, localPort: this.#options.localPort,
      resolveEndpointId: () => this.#prepareIdentity(),
      createGateway: ({ endpointId }) => this.#options.gatewayFactory({
        mobile: this.#options.mobile, endpointId, localPort: this.#options.localPort, backendHost: this.#options.backendHost,
        upstreamOrigin: this.#options.upstreamOrigin, upstreamAuthenticatedUrl: this.#options.upstreamAuthenticatedUrl,
        stateFile: join(this.#options.dataDirectory, 'mobile-devices.json'), tls: this.#options.tls,
        tlsManager: this.#options.tlsManager, extensionHost: this.#options.extensionHost,
        tlsCheckIntervalMs: this.#options.tlsCheckIntervalMs, tlsRenewBeforeMs: this.#options.tlsRenewBeforeMs,
        signal: this.#preferenceAbort.signal,
      }),
      createSidecar: async ({ proxyTarget }) => {
        const sidecar = await this.#options.sidecarFactory({ executable: this.#options.executable, dataDir: this.#options.dataDirectory, proxyTarget })
        if (this.#controller === controller) this.#sidecar = sidecar
        return sidecar
      },
      onStatus: () => {
        if (this.#controller !== controller) return
        if (controller.status().state === 'error') { this.#mustRetire = true; this.#stopped = true }
        if (controller.status().state !== 'ready') this.#cancelWait?.(fault('host_operator_transport_changed'))
        this.#notify()
      },
    })
    return controller
  }

  async #prepareIdentity() {
    this.#identityTask ??= Promise.resolve().then(() => this.#options.resolveIdentity({ executable: this.#options.executable, dataDir: this.#options.dataDirectory }))
      .then((id) => { if (typeof id !== 'string' || !ENDPOINT_ID.test(id)) throw fault('host_operator_identity_failed'); return id })
      .catch(() => { this.#identityTask = undefined; throw fault('host_operator_identity_failed') })
    return this.#identityTask
  }

  async #loadState() {
    const state = await this.#options.store.load({ signal: this.#preferenceAbort.signal })
    if (state === null || typeof state !== 'object' || Object.keys(state).sort().join(',') !== 'enabled,version'
      || state.version !== 1 || typeof state.enabled !== 'boolean') throw fault('invalid_host_operator_state')
    return state
  }

  async #saveState(state) {
    if (this.#closed) throw fault('host_operator_cancelled')
    await this.#options.store.save(state, { signal: this.#preferenceAbort.signal })
  }

  #check(generation) {
    if (this.#closed || generation !== this.#generation) throw fault('host_operator_cancelled')
  }

  #running(generation) {
    this.#check(generation)
    const gateway = this.#controller.gateway()
    if (this.#stopped || this.#mustRetire || this.#controller.status().state !== 'ready' || !this.#sidecar || !gateway) throw fault('host_operator_not_ready')
    return { sidecar: this.#sidecar, gateway }
  }

  #enqueue(operation) {
    const task = this.#queue.then(operation, operation)
    this.#queue = task.then(() => undefined, () => undefined)
    return task
  }

  #invalidate() {
    this.#generation += 1
    this.#preferenceAbort.abort()
    this.#preferenceAbort = new AbortController()
    this.#cancelWait?.(fault('host_operator_cancelled'))
  }

  async #retire() {
    this.#mustRetire = true
    await this.#controller.close()
    // A later explicit start must revalidate storage permissions and identity,
    // not reuse a permission-success result from an earlier process lifetime.
    this.#identityTask = undefined
  }

  async #failOperation(error, generation, fallback) {
    const code = error instanceof HostOperatorError ? error.code : fallback
    if (code === 'host_operator_not_ready' && this.#mustRetire && this.#errorCode === 'host_operator_control_uncertain') throw fault(code)
    if (!this.#closed && generation === this.#generation) {
      this.#errorCode = code; this.#stopped = true
      try { await this.#retire() } catch { this.#errorCode = 'host_operator_cleanup_failed' }
      this.#notify()
    }
    throw fault(this.#closed || generation !== this.#generation ? 'host_operator_cancelled' : this.#errorCode ?? code)
  }

  #freshEvent(sidecar, command, predicate, generation) {
    let remove = () => {}
    const event = new Promise((resolve, reject) => {
      remove = sidecar.onEvent((event) => {
        if (predicate(event)) resolve(event)
        else if (['sidecar-exit', 'sidecar-error', 'sidecar-protocol-error', 'error'].includes(event.type)) reject(fault('host_operator_transport_changed'))
      })
      try { sidecar.send(command) } catch { reject(fault('host_operator_command_failed')) }
    })
    return this.#bounded(event, generation, () => remove())
  }

  #bounded(promise, generation, cleanup = () => {}) {
    return new Promise((resolve, reject) => {
      let done = false
      const finish = (error, value) => {
        if (done) return
        done = true; clearTimeout(timer); cleanup()
        if (this.#cancelWait === cancel) this.#cancelWait = undefined
        if (error !== undefined) reject(error)
        else { try { this.#check(generation); resolve(value) } catch (failure) { reject(failure) } }
      }
      const cancel = (error) => finish(error)
      const timer = setTimeout(() => finish(fault('host_operator_command_timeout')), this.#options.commandTimeoutMs)
      this.#cancelWait = cancel
      promise.then((value) => finish(undefined, value), error => finish(error instanceof HostOperatorError ? error : fault('host_operator_command_failed')))
      if (this.#closed || generation !== this.#generation) cancel(fault('host_operator_cancelled'))
    })
  }

  #notify() {
    try {
      const result = this.#options.onStatus?.(this.status())
      if (result !== undefined && typeof result?.then === 'function') void Promise.resolve(result).catch(() => {})
    } catch { /* Display observers do not own transport or pairing. */ }
  }
}

/** Construct an inert trusted-operator owner; call start() explicitly to connect. */
export function createHostSession(options) { return new IrohHostSession(options) }
