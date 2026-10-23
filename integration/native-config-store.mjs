import { NativeCommandOwner } from './native-command-owner.mjs'

/** Redacted non-secret configuration storage failures. */
export class NativeConfigError extends Error {
  constructor(code) { super(code); this.name = 'NativeConfigError'; this.code = code }
}
const fault = code => new NativeConfigError(code)

/** Validate the fixed non-secret configuration; query, fragment and user information are forbidden. */
export function validateOperatorConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'localOnly,localPort,upstreamOrigin,version' || value.version !== 1
    || !Number.isInteger(value.localPort) || value.localPort < 1024 || value.localPort > 65535
    || typeof value.localOnly !== 'boolean' || typeof value.upstreamOrigin !== 'string') throw fault('invalid_operator_config')
  let url
  try { url = new URL(value.upstreamOrigin) } catch { throw fault('invalid_operator_config') }
  if (!['http:','https:'].includes(url.protocol) || !['127.0.0.1','[::1]'].includes(url.hostname)
    || url.origin !== value.upstreamOrigin || url.username || url.password || url.search || url.hash) throw fault('invalid_operator_config')
  return Object.freeze({ version:1,upstreamOrigin:url.origin,localPort:value.localPort,localOnly:value.localOnly })
}

/** Fixed operator-config.json access through the native protected-state constructor. */
export class NativeConfigStore {
  #commands
  constructor(options) { this.#commands = new NativeCommandOwner({ ...options,fault,prefix:'operator_config',maxOutputBytes:1024 }) }
  /** Absence is null, not a silently changed port. */
  load(options) { return this.#run('operator-config-load',undefined,options) }
  /** Save only canonical no-query Origin and non-secret local transport settings. */
  save(value,options) {
    let config
    try { config = validateOperatorConfig(value) } catch (error) { return Promise.reject(error) }
    return this.#run('operator-config-save',config,options)
  }
  /** Cancel work and await actual close; failed cleanup remains retryable. */
  close() { return this.#commands.close() }
  #run(command,config,options) {
    const args = config ? ['--upstream-origin',config.upstreamOrigin,'--local-port',String(config.localPort),'--local-only',String(config.localOnly)] : []
    return this.#commands.run(command,args,text => {
      const value = JSON.parse(text)
      if (value === null && config === undefined && text === 'null\n') return null
      const valid = validateOperatorConfig(value)
      if (text !== `${JSON.stringify(valid)}\n` || config && JSON.stringify(valid) !== JSON.stringify(config)) throw fault('invalid_operator_config_response')
      return valid
    },options)
  }
}
