import { NativeCommandOwner } from './native-command-owner.mjs'

const validState = state => state !== null && typeof state === 'object' && !Array.isArray(state)
  && Object.keys(state).sort().join(',') === 'enabled,version' && state.version === 1 && typeof state.enabled === 'boolean'

/** Redacted operator-state failures never include native output, private paths or arguments. */
export class NativePreferenceError extends Error {
  constructor(code) { super(code); this.name = 'NativePreferenceError'; this.code = code }
}
const fault = code => new NativePreferenceError(code)

/** Fixed versioned startup preference storage through the native private-state owner. */
export class NativePreferenceStore {
  #commands
  constructor(options) { this.#commands = new NativeCommandOwner({ ...options,fault,prefix:'preference',maxOutputBytes:256 }) }
  /** Absence is disabled; corrupt or unsafe state fails closed without repair. */
  load(options) { return this.#run('preference-load',undefined,options) }
  /** Save a strict boolean, never an arbitrary filename or JSON document. */
  save(state,options) {
    if (!validState(state)) return Promise.reject(fault('invalid_preference_state'))
    return this.#run('preference-save',state.enabled,options)
  }
  /** Cancel work and wait for actual child close; failed cleanup is retryable. */
  close() { return this.#commands.close() }
  #run(command,enabled,options) {
    return this.#commands.run(command,enabled === undefined ? [] : ['--enabled',String(enabled)],text => {
      const state = JSON.parse(text)
      if (!validState(state) || text !== `${JSON.stringify({ version:1,enabled:state.enabled })}\n`
        || enabled !== undefined && state.enabled !== enabled) throw fault('invalid_preference_response')
      return Object.freeze(state)
    },options)
  }
}
