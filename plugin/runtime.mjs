import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { isAbsolute } from 'node:path'
import { createOperatorOwner } from '../integration/operator-owner.mjs'
import { createOperatorServer } from '../operator/server.mjs'
import { openOperatorUrl } from '../operator/cli.mjs'
import { currentHostOrigin } from './security.mjs'

const fail = code => Object.assign(new Error(code),{ code })

/** One installed plugin owns its independent Gateway, sidecar and management listener. */
export function createPluginRuntime({ webServer,connection,dataDirectory },{
  resolveNative = async () => (await import('../src/native-artifact.mjs')).resolveNativeHost(),
  loadMobile = async () => { const modulePath = createRequire(import.meta.url).resolve('dsh-mobile'); return { modulePath,mobile:await import(pathToFileURL(modulePath).href) } },
  loadQr = async () => createRequire(import.meta.url)('qrcode'),
  ownerFactory = createOperatorOwner,serverFactory = createOperatorServer,openUrl = openOperatorUrl,
} = {}) {
  if (!isAbsolute(dataDirectory ?? '')) throw fail('iroh_private_directory_required')
  const origin = currentHostOrigin(webServer)
  const lifetime = new AbortController()
  let owner,server,initializing,initialized = false,launching,closed = false,closeTask,authorizedUrl
  const check = signal => { if (closed || lifetime.signal.aborted || signal?.aborted) throw fail('iroh_operation_cancelled') }
  const boundOwner = () => Object.freeze({
    managedHost:true,
    status:() => ({ ...owner.status(),managedHost:true }),
    configure:async (value,options) => {
      if (!value || Object.keys(value).sort().join(',') !== 'localOnly,localPort,version') throw fail('iroh_invalid_configuration')
      return owner.configure({ ...value,upstreamAuthenticatedUrl:authorizedUrl },options)
    },
    ...Object.fromEntries(['start','stop','reconnect','openPairing','cancelPairing','listPeers','forgetPeer','renewTls'].map(method => [method,(...args) => owner[method](...args)])),
  })
  const initialize = () => {
    if (closed) return Promise.reject(fail('iroh_operation_cancelled'))
    if (initialized) return Promise.resolve()
    if (initializing) return initializing
    initializing = (async () => {
      if (owner) { await owner.close(); owner = undefined }
      const executable = await resolveNative(); check()
      const { mobile,modulePath } = await loadMobile(); check()
      const candidate = connection.authenticatedUrl(origin)
      let url
      try { url = new URL(candidate) } catch { throw fail('iroh_host_authentication_required') }
      if (url.origin !== origin || url.username || url.password || url.hash || !url.searchParams.get('token')) throw fail('iroh_host_authentication_required')
      authorizedUrl = url.href
      owner = ownerFactory({ mobile,modulePath,executable,dataDirectory })
      await owner.authorizeCurrentHost(authorizedUrl,{ signal:lifetime.signal }); check()
      initialized = true
      // Startup failure stays visible in this owner's console, not in DSH boot.
      if (owner.status().enabled) { try { await owner.restore({ signal:lifetime.signal }) } catch { check() } }
    })().catch(() => { throw fail('iroh_initialization_failed') }).finally(() => { initializing = undefined })
    return initializing
  }
  const launch = ({ signal } = {}) => {
    if (launching) return Promise.reject(fail('iroh_launch_busy'))
    launching = (async () => {
      check(signal); await initialize(); check(signal)
      if (!server) {
        const qr = await loadQr(); check(signal)
        server = await serverFactory({ owner:boundOwner(),renderQr:payload => qr.toBuffer(payload,{ type:'png',errorCorrectionLevel:'M' }) })
      }
      check(signal)
      await openUrl(server.issueLaunchUrl()); check(signal)
    })().catch(error => {
      if (error?.browserOwner) browserOwners.add(error.browserOwner)
      throw fail(error?.code === 'iroh_operation_cancelled' ? error.code : 'iroh_open_failed')
    }).finally(() => { launching = undefined })
    return launching
  }
  const browserOwners = new Set()
  const close = () => {
    if (closeTask) return closeTask
    closed = true; lifetime.abort()
    closeTask = (async () => {
      await Promise.allSettled([initializing,launching])
      for (const browserOwner of browserOwners) { await browserOwner.close(); browserOwners.delete(browserOwner) }
      await server?.close(); server = undefined
      await owner?.close(); owner = undefined; authorizedUrl = undefined
    })().catch(() => { closeTask = undefined; throw fail('iroh_cleanup_failed') })
    return closeTask
  }
  return Object.freeze({ origin,initialize,launch,close })
}
