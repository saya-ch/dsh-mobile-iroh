import { isAbsolute } from 'node:path'
import { NativePreferenceStore } from './native-preference-store.mjs'
import { NativeConfigStore, validateOperatorConfig } from './native-config-store.mjs'
import { NativeTlsManager } from './native-tls-manager.mjs'
import { createExtensionHost } from './extension-host.mjs'
import { createHostSession } from './host-session.mjs'
import { DEFAULT_IROH_LOCAL_PORT } from './origin-contract.mjs'

/** Fixed failures never expose DSH credentials, private paths or nested owner errors. */
export class OperatorOwnerError extends Error {
  constructor(code) { super(code); this.name = 'OperatorOwnerError'; this.code = code }
}
const fault = code => new OperatorOwnerError(code)
const signalValid = signal => signal === undefined || signal instanceof AbortSignal

function validateAuthorizedConfiguration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'localOnly,localPort,upstreamAuthenticatedUrl,version'
    || typeof value.upstreamAuthenticatedUrl !== 'string' || value.upstreamAuthenticatedUrl.length > 8192
    || /[\u0000-\u001f\u007f]/u.test(value.upstreamAuthenticatedUrl)) throw fault('invalid_operator_configuration')
  let url
  try { url = new URL(value.upstreamAuthenticatedUrl) } catch { throw fault('invalid_operator_configuration') }
  if (url.username || url.password || url.hash || !url.searchParams.get('token')) throw fault('invalid_operator_configuration')
  let config
  try { config = validateOperatorConfig({ version:value.version,upstreamOrigin:url.origin,localPort:value.localPort,localOnly:value.localOnly }) }
  catch { throw fault('invalid_operator_configuration') }
  return { config,authorizedUrl:url.href }
}

/**
 * Inert independent runtime owner. Only non-secret settings are persisted;
 * full upstream authorization remains in this instance's private memory.
 * Stop/close invalidate startup before waiting for actual Host cleanup.
 */
export class IrohOperatorOwner {
  #options
  #preferences
  #configStore
  #tls
  #extension
  #failedExtension = false
  #session
  #sessionClose
  #config
  #authorizedUrl
  #initialized = false
  #initializeTask
  #enabled = false
  #state = 'unconfigured'
  #errorCode
  #generation = 0
  #queue = Promise.resolve()
  #workAborts = new Set()
  #activation
  #stopTask
  #closed = false
  #closeTask
  #lifetime = new AbortController()
  #inflight = new Set()

  constructor({ mobile,modulePath,executable,dataDirectory,backendHost = '127.0.0.1',providers = [],localDirectory,hostExecution,
    preferenceStore,configStore,tlsManager,sessionFactory = createHostSession,extensionFactory = createExtensionHost,
    now = () => Date.now(),...sessionOptions } = {}) {
    if (!mobile || !isAbsolute(modulePath ?? '') || !isAbsolute(executable ?? '') || !isAbsolute(dataDirectory ?? '')
      || !['127.0.0.1','::1'].includes(backendHost) || typeof sessionFactory !== 'function' || typeof extensionFactory !== 'function'
      || typeof now !== 'function' || !Array.isArray(providers) || providers.some(provider => typeof provider !== 'function')
      || localDirectory !== undefined && !isAbsolute(localDirectory)) throw fault('invalid_operator_owner_options')
    this.#options = { mobile,modulePath,executable,dataDirectory,backendHost,providers,localDirectory,hostExecution,sessionFactory,extensionFactory,now,sessionOptions }
    this.#preferences = preferenceStore ?? new NativePreferenceStore({ executable,dataDirectory })
    this.#configStore = configStore ?? new NativeConfigStore({ executable,dataDirectory })
    this.#tls = tlsManager ?? new NativeTlsManager({ executable,dataDirectory })
  }

  /** Load non-secret settings and enabled intent, without starting a Gateway or importing a profile. */
  initialize({ signal } = {}) {
    if (!signalValid(signal)) return Promise.reject(fault('invalid_operator_signal'))
    if (this.#closed) return Promise.reject(fault('operator_owner_closed'))
    if (this.#initialized) return Promise.resolve(this.status())
    if (this.#initializeTask) return this.#initializeTask
    this.#initializeTask = this.#serialize(async () => {
      try {
        const combined = signal ? AbortSignal.any([signal,this.#lifetime.signal]) : this.#lifetime.signal
        combined.throwIfAborted()
        const config = await this.#configStore.load({ signal:combined })
        const preference = await this.#preferences.load({ signal:combined })
        combined.throwIfAborted()
        if (this.#closed) throw fault('operator_owner_closed')
        this.#config = config === null ? undefined : validateOperatorConfig(config)
        if (this.#authorizedUrl && new URL(this.#authorizedUrl).origin !== this.#config?.upstreamOrigin) this.#authorizedUrl = undefined
        if (!preference || Object.keys(preference).sort().join(',') !== 'enabled,version' || preference.version !== 1 || typeof preference.enabled !== 'boolean') throw fault('invalid_operator_preference')
        this.#enabled = preference.enabled; this.#initialized = true; this.#errorCode = undefined
        return this.status()
      } catch { this.#errorCode = 'operator_initialize_failed'; throw fault(this.#errorCode) }
    }).finally(() => { this.#initializeTask = undefined })
    return this.#initializeTask
  }

  /** Safe status contains no private-state paths, authorized URLs, keys or pairing material. */
  status() {
    const current = this.#session?.status()
    const rawTls = this.#session?.tlsStatus?.() ?? this.#tls.status()
    const notAfter = rawTls?.leafValidTo
    const tlsState = rawTls?.state === 'error' ? 'error' : !Number.isSafeInteger(notAfter) ? 'missing'
      : notAfter <= this.#options.now() ? 'expired' : notAfter - this.#options.now() <= 30*86400000 ? 'expiring' : 'valid'
    const result = { enabled:current?.enabled ?? this.#enabled,state:this.#errorCode ? 'error' : this.#state === 'starting' || this.#state === 'stopping' ? this.#state : this.#closed ? 'off' : current?.state ?? this.#state,
      configured:!!this.#authorizedUrl,localPort:this.#config?.localPort ?? DEFAULT_IROH_LOCAL_PORT,localOnly:this.#config?.localOnly ?? false,
      tls:{ state:tlsState,renewable:current?.state === 'ready',...(Number.isSafeInteger(notAfter) ? { notAfter } : {}) } }
    if (this.#config) result.upstreamOrigin = this.#config.upstreamOrigin
    if (/^[a-f0-9]{64}$/u.test(current?.endpointId ?? '')) result.endpointId = current.endpointId
    if (current?.origin) result.origin = current.origin
    if (this.#errorCode) result.errorCode = this.#errorCode
    if (/^[a-z][a-z0-9_]{0,79}$/u.test(current?.controlErrorCode ?? '')) result.controlErrorCode = current.controlErrorCode
    return Object.freeze(result)
  }

  /** Save only non-secret settings; a cancelled durable commit is not claimed rolled back. */
  configure(value,{ signal } = {}) {
    let parsed
    try { parsed = validateAuthorizedConfiguration(value); this.#available(signal) } catch (error) { return Promise.reject(error) }
    if (this.#activation || this.#stopTask || this.#session || !['off','unconfigured','error'].includes(this.#state)) return Promise.reject(fault('operator_stop_before_configuring'))
    return this.initialize({ signal }).then(() => this.#serialize(async () => {
      this.#available(signal)
      if (this.#session || this.#activation || this.#stopTask) throw fault('operator_stop_before_configuring')
      const generation = this.#generation
      const abort = new AbortController(); this.#workAborts.add(abort)
      const combined = AbortSignal.any([this.#lifetime.signal,abort.signal,...(signal ? [signal] : [])])
      try {
        await this.#configStore.save(parsed.config,{ signal:combined })
        this.#check(generation,combined)
        this.#config = parsed.config; this.#authorizedUrl = parsed.authorizedUrl; this.#state = 'off'; this.#errorCode = undefined
        return this.status()
      } catch { this.#initialized = false; this.#authorizedUrl = undefined; this.#errorCode = 'operator_configuration_outcome_unknown'; throw fault(this.#errorCode) }
      finally { this.#workAborts.delete(abort) }
    }))
  }

  /** Explicitly enable after authorization has been supplied for this process. */
  start(options) { return this.#activate('start',options) }
  /** Re-read saved startup intent using the current process's authorized entry. */
  restore(options) { return this.#activate('restore',options) }
  /** Explicitly replace the active transport while preserving identity and peer records. */
  reconnect(options) { return this.#activate('reconnect',options) }

  #activate(method,{ signal } = {}) {
    try { this.#available(signal) } catch (error) { return Promise.reject(error) }
    if (this.#activation || this.#stopTask) return Promise.reject(fault('operator_owner_busy'))
    const generation = this.#generation
    const abort = new AbortController(); this.#workAborts.add(abort)
    const combined = AbortSignal.any([this.#lifetime.signal,abort.signal,...(signal ? [signal] : [])])
    const cancel = () => { if (this.#generation === generation) this.#generation++; void this.#retireSession().catch(() => { this.#errorCode = 'operator_cleanup_failed' }) }
    combined.addEventListener('abort',cancel,{ once:true })
    this.#state = 'starting'
    this.#activation = (async () => {
      await this.initialize({ signal:combined })
      return this.#serialize(async () => {
        try {
          this.#check(generation,combined)
          if (!this.#authorizedUrl || !this.#config) throw fault('operator_configuration_required')
          if (this.#failedExtension) {
            try { await this.#extension.close() } catch { throw fault('operator_cleanup_failed') }
            this.#extension = undefined; this.#failedExtension = false
            this.#check(generation,combined)
          }
          if (!this.#extension) {
            try { this.#extension = await this.#options.extensionFactory(this.#options) }
            catch (error) {
              if (error?.extensionHost) { this.#extension = error.extensionHost; this.#failedExtension = true }
              throw error
            }
          }
          this.#check(generation,combined)
          if (!this.#session) this.#session = this.#options.sessionFactory({ ...this.#options.sessionOptions,mobile:this.#options.mobile,executable:this.#options.executable,dataDirectory:this.#options.dataDirectory,
            upstreamOrigin:this.#config.upstreamOrigin,upstreamAuthenticatedUrl:this.#authorizedUrl,localPort:this.#config.localPort,localOnly:this.#config.localOnly,
            backendHost:this.#options.backendHost,store:this.#preferences,tlsManager:this.#tls,extensionHost:this.#extension })
          this.#check(generation,combined)
          await this.#session[method]()
          this.#check(generation,combined)
          this.#enabled = this.#session.status().enabled; this.#state = this.#session.status().state; this.#errorCode = undefined
          return this.status()
        } catch (error) {
          try { await this.#retireSession() } catch { this.#errorCode = 'operator_cleanup_failed'; throw fault(this.#errorCode) }
          this.#state = this.#authorizedUrl ? 'off' : 'unconfigured'
          const code = combined.aborted || generation !== this.#generation ? 'operator_operation_cancelled' : error instanceof OperatorOwnerError ? error.code : 'operator_start_failed'
          if (generation === this.#generation) this.#errorCode = code
          throw fault(code)
        }
      })
    })().finally(() => { combined.removeEventListener('abort',cancel); this.#workAborts.delete(abort); this.#activation = undefined })
    return this.#activation
  }

  /** Stop immediately invalidates pending startup, then durably disables after actual cleanup. */
  stop({ signal } = {}) {
    try { this.#available(signal) } catch (error) { return Promise.reject(error) }
    if (this.#stopTask) return this.#stopTask
    this.#invalidate(); this.#state = 'stopping'
    const closing = this.#retireSession()
    this.#stopTask = (async () => {
      await closing
      await this.#serialize(async () => {
        await this.#retireSession()
        signal?.throwIfAborted()
        const state = await this.#preferences.load({ signal })
        if (!state || state.version !== 1 || typeof state.enabled !== 'boolean') throw fault('invalid_operator_preference')
        await this.#preferences.save({ version:1,enabled:false },{ signal })
        this.#enabled = false; this.#state = this.#authorizedUrl ? 'off' : 'unconfigured'; this.#errorCode = undefined
      })
      return this.status()
    })().catch(() => { this.#errorCode = 'operator_stop_outcome_unknown'; throw fault(this.#errorCode) }).finally(() => { this.#stopTask = undefined })
    return this.#stopTask
  }

  /** Pairing/read operations do not retire a working transport when only the HTTP caller leaves. */
  openPairing(options) { return this.#sessionOperation('openPairing',undefined,options) }
  listPeers(options) { return this.#sessionOperation('listPeers',undefined,options) }
  forgetPeer(id,options) { return this.#sessionOperation('forgetPeer',id,options) }
  renewTls(options) { return this.#sessionOperation('renewTls',undefined,options,true) }
  cancelPairing({ signal } = {}) {
    if (!signalValid(signal)) return Promise.reject(fault('invalid_operator_signal'))
    if (!this.#session || this.#session.status().state !== 'ready') return Promise.resolve({ cancelled:true })
    return this.#sessionOperation('cancelPairing',undefined,{ signal })
  }
  #sessionOperation(method,value,{ signal } = {},forwardSignal = false) {
    const task = (async () => {
      this.#available(signal)
      const session = this.#session,generation = this.#generation
      if (!session || session.status().state !== 'ready') throw fault('operator_not_ready')
      try {
        const result = await (value === undefined ? session[method](forwardSignal ? { signal } : undefined) : session[method](value))
        this.#check(generation,signal)
        if (session !== this.#session) throw fault('operator_operation_cancelled')
        return result
      } catch { throw fault(signal?.aborted || generation !== this.#generation ? 'operator_operation_cancelled' : 'operator_operation_failed') }
    })()
    this.#inflight.add(task)
    return task.finally(() => { this.#inflight.delete(task) })
  }

  /** Terminal close retains failed owners and dependency order for explicit retry. */
  close() {
    if (this.#closeTask) return this.#closeTask
    this.#closed = true; this.#state = 'stopping'; this.#authorizedUrl = undefined; this.#invalidate(); this.#lifetime.abort()
    const retiring = this.#retireSession()
    this.#closeTask = (async () => {
      await retiring
      await this.#queue
      await this.#retireSession()
      await Promise.allSettled([...this.#inflight])
      if (this.#extension) { await this.#extension.close(); this.#extension = undefined; this.#failedExtension = false }
      await this.#tls.close()
      await this.#preferences.close()
      await this.#configStore.close()
      this.#state = 'off'; this.#errorCode = undefined
    })().catch(() => { this.#closeTask = undefined; this.#errorCode = 'operator_cleanup_failed'; throw fault(this.#errorCode) })
    return this.#closeTask
  }

  #available(signal) { if (!signalValid(signal)) throw fault('invalid_operator_signal'); if (this.#closed) throw fault('operator_owner_closed'); if (signal?.aborted) throw fault('operator_operation_cancelled') }
  #check(generation,signal) { this.#available(signal); if (generation !== this.#generation) throw fault('operator_operation_cancelled') }
  #invalidate() { this.#generation++; for (const abort of this.#workAborts) abort.abort() }
  #serialize(operation) { const task = this.#queue.then(operation,operation); this.#queue = task.then(() => undefined,() => undefined); return task }
  #retireSession() {
    if (this.#sessionClose) return this.#sessionClose
    const session = this.#session
    if (!session) return Promise.resolve()
    this.#sessionClose = Promise.resolve().then(() => session.close()).then(() => { if (this.#session === session) this.#session = undefined }).finally(() => { this.#sessionClose = undefined })
    return this.#sessionClose
  }
}

/** Construct an inert runtime; initialize reads safe settings but never starts transport. */
export function createOperatorOwner(options) { return new IrohOperatorOwner(options) }
