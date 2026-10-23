import { createPrivateKey, X509Certificate } from 'node:crypto'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { irohHostname, irohOrigin } from './origin-contract.mjs'

const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const DEFAULT_RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000

function cleanupFailure(errors, owner) {
  const error = new AggregateError(errors, 'iroh gateway activation and cleanup failed')
  Object.defineProperty(error, 'gatewayCleanup', { value: owner })
  return error
}

async function boundedPem(path) {
  const file = await open(path, 'r')
  try {
    const metadata = await file.stat()
    if (!metadata.isFile() || metadata.size > 8192) throw new Error('TLS material must be a bounded regular file')
    const bytes = Buffer.alloc(8193)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > 8192) throw new Error('TLS material exceeds byte limit')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
  } finally { await file.close() }
}

async function validateMaterial(tls, hostname, expected) {
  const [caPem, leafPem, keyPem] = await Promise.all([boundedPem(tls.caFile), boundedPem(tls.certFile), boundedPem(tls.keyFile)])
  const ca = new X509Certificate(caPem), leaf = new X509Certificate(leafPem)
  if (!ca.ca || leaf.ca || ca.subject !== ca.issuer || !ca.verify(ca.publicKey) || !leaf.verify(ca.publicKey)
    || !leaf.checkPrivateKey(createPrivateKey(keyPem)) || leaf.subjectAltName !== `DNS:${hostname}`
    || leaf.checkHost(hostname, { wildcards: false, subject: 'never' }) !== hostname) {
    throw new Error('iroh gateway requires its own CA and an exact endpoint-hostname leaf certificate')
  }
  const now = Date.now()
  if ([ca, leaf].some(cert => Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) <= now)) {
    throw new Error('iroh gateway certificate is outside its validity period')
  }
  const metadata = Object.freeze({
    instanceId: ca.fingerprint256.replaceAll(':', '').toLowerCase(),
    caFingerprint256: ca.fingerprint256.replaceAll(':', '').toLowerCase(),
    leafFingerprint256: leaf.fingerprint256.replaceAll(':', '').toLowerCase(),
    caValidTo: Date.parse(ca.validTo), leafValidTo: Date.parse(leaf.validTo),
  })
  if (expected !== undefined && ['instanceId', 'caFingerprint256', 'leafFingerprint256', 'caValidTo', 'leafValidTo']
    .some(key => expected[key] !== metadata[key])) throw new Error('TLS material changed outside its recorded preparation')
  return { ca, metadata }
}

/**
 * Create a dedicated Mobile Gateway through its public exports, without changing
 * the production plugin or exporting DSH launch credentials to the sidecar.
 * The phone forwards TLS bytes unchanged; the certificate and key stay on the host.
 * The caller retains the TLS manager and extension host; this owner drains its
 * renewal work before closing the Gateway and retains failed cleanup internally.
 */
export function createIrohGatewayFactory({ mobile, endpointId, localPort, backendHost = '127.0.0.1', upstreamOrigin, upstreamAuthenticatedUrl, stateFile, tls,
  tlsManager, tlsCheckIntervalMs = DEFAULT_CHECK_INTERVAL_MS, tlsRenewBeforeMs = DEFAULT_RENEW_BEFORE_MS, extensionHost, signal }) {
  const advertisedOrigin = irohOrigin(endpointId, localPort)
  const hostname = irohHostname(endpointId)
  if (!['127.0.0.1', '::1'].includes(backendHost)) throw new Error('iroh gateway must bind an explicit loopback address')
  if (!isAbsolute(stateFile ?? '') || (tls === undefined) === (tlsManager === undefined)
    || tls !== undefined && (Object.keys(tls).sort().join(',') !== 'caFile,certFile,keyFile'
      || Object.values(tls).some(file => typeof file !== 'string' || !isAbsolute(file)))
    || tlsManager !== undefined && (typeof tlsManager.withPrepared !== 'function' || typeof tlsManager.withRenewed !== 'function')
    || !Number.isSafeInteger(tlsCheckIntervalMs) || tlsCheckIntervalMs < 1 || tlsCheckIntervalMs > 2147483647
    || !Number.isSafeInteger(tlsRenewBeforeMs) || tlsRenewBeforeMs < 1
    || signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new Error('iroh gateway requires absolute state and either explicit TLS files or a leased TLS manager')
  }
  if (!mobile || typeof mobile.parseGatewayConfig !== 'function' || typeof mobile.MobileAccessGateway !== 'function'
    || typeof mobile.JsonDeviceStore !== 'function') throw new Error('public DSH Mobile Gateway exports are required')

  return async function startIrohGateway() {
    let createdBackend, gatewayCleanup, cleanupNeeded = false
    const activatePrepared = async (prepared, leaseSignal) => {
      const checkStartup = () => { if (signal?.aborted || leaseSignal?.aborted) throw new Error('iroh_gateway_start_cancelled') }
      checkStartup()
      const files = prepared?.tls ?? tls
      const { ca, metadata: initialMetadata } = await validateMaterial(files, hostname, prepared)
      checkStartup()
      const instanceId = initialMetadata.instanceId
      const config = mobile.parseGatewayConfig({
        listenHost: backendHost, listenPort: Number(new URL(advertisedOrigin).port),
        publicAuthorities: [new URL(advertisedOrigin).host], allowedCidrs: [backendHost === '::1' ? '::1/128' : '127.0.0.1/32'],
        upstreamOrigin, stateFile, instanceId, pairingCaFile: files.caFile,
        tls: { mode: 'provided', certFile: files.certFile, keyFile: files.keyFile }, discovery: false,
      })
      const gateway = new mobile.MobileAccessGateway(config, new mobile.JsonDeviceStore(stateFile), extensionHost?.service, upstreamAuthenticatedUrl)
      let gatewayCloseTask
      const closeGateway = () => {
        if (gatewayCloseTask !== undefined) return gatewayCloseTask
        gatewayCloseTask = Promise.resolve().then(() => gateway.close()).then(() => { cleanupNeeded = false })
          .catch(error => { gatewayCloseTask = undefined; throw error })
        return gatewayCloseTask
      }
      gatewayCleanup = Object.freeze({ close: closeGateway }); cleanupNeeded = true
      try {
        if (tlsManager !== undefined && typeof gateway.refreshProvidedTls !== 'function') {
          throw new Error('public DSH Mobile refreshProvidedTls export is required for managed certificates')
        }
        checkStartup(); await gateway.start(); checkStartup()
      } catch (error) {
        try { await closeGateway() } catch (cleanupError) { throw cleanupFailure([error, cleanupError], gatewayCleanup) }
        throw error
      }
      const proxyTarget = `https://${backendHost === '::1' ? '[::1]' : backendHost}:${gateway.address().port}`
      let activeMetadata = initialMetadata, errorCode, timer, closed = false, renewal, closeTask
      const abort = new AbortController()
      const ownerSignal = AbortSignal.any([abort.signal, signal, leaseSignal].filter(value => value !== undefined))
      const withdrawTimer = () => { clearTimeout(timer) }
      ownerSignal.addEventListener('abort', withdrawTimer, { once: true })
      const tlsStatus = () => Object.freeze({ state: closed ? 'closed' : errorCode === undefined ? 'ready' : 'error',
        managed: tlsManager !== undefined, ...activeMetadata, ...(errorCode === undefined ? {} : { errorCode }) })
      const renewTls = ({ signal } = {}) => {
        if (closed) return Promise.reject(new Error('iroh_tls_owner_closed'))
        if (tlsManager === undefined) return Promise.reject(new Error('iroh_tls_external_material'))
        if (signal !== undefined && !(signal instanceof AbortSignal)) return Promise.reject(new Error('invalid_tls_signal'))
        if (renewal !== undefined) return renewal
        const combinedSignal = signal === undefined ? ownerSignal : AbortSignal.any([ownerSignal, signal])
        renewal = (async () => {
          const activateRenewed = async (next, leaseSignal) => {
            const refreshingSignal = leaseSignal === undefined ? combinedSignal : AbortSignal.any([combinedSignal, leaseSignal])
            if (closed || refreshingSignal.aborted) throw new Error('iroh_tls_renewal_cancelled')
            if (Object.keys(files).some(key => files[key] !== next.tls?.[key])) throw new Error('iroh_tls_paths_changed')
            const { metadata } = await validateMaterial(files, hostname, next)
            if (metadata.instanceId !== instanceId) throw new Error('iroh_tls_ca_changed')
            if (closed || refreshingSignal.aborted) throw new Error('iroh_tls_renewal_cancelled')
            await gateway.refreshProvidedTls()
            if (closed) throw new Error('iroh_tls_owner_closed')
            activeMetadata = metadata; errorCode = undefined
            return tlsStatus()
          }
          return tlsManager.withRenewed({ endpointId, signal: combinedSignal }, activateRenewed)
        })().catch(() => { errorCode = 'iroh_tls_renewal_failed'; throw new Error(errorCode) })
          .finally(() => { renewal = undefined })
        return renewal
      }
      const schedule = () => {
        if (closed || ownerSignal.aborted || tlsManager === undefined) return
        const untilRenewal = activeMetadata.leafValidTo - Date.now() - tlsRenewBeforeMs
        timer = setTimeout(() => {
          if (closed) return
          const checking = Date.now() + tlsRenewBeforeMs >= activeMetadata.leafValidTo ? renewTls() : Promise.resolve()
          void checking.catch(() => { /* Safe error state is retained; next check and explicit retry remain available. */ }).finally(schedule)
        }, untilRenewal > 0 ? Math.min(tlsCheckIntervalMs, untilRenewal) : tlsCheckIntervalMs)
        timer.unref?.()
      }
      schedule()
      const close = () => {
        if (closeTask !== undefined) return closeTask
        closed = true; clearTimeout(timer); abort.abort(); ownerSignal.removeEventListener('abort', withdrawTimer)
        closeTask = (async () => {
          // Withdraw and drain refresh work before closing the listener. A rejected
          // renewal is observable through tlsStatus and does not prevent cleanup.
          await Promise.allSettled([renewal])
          try { await closeGateway() } catch { throw new Error('iroh_gateway_close_failed') }
        })().catch(error => { closeTask = undefined; throw error })
        return closeTask
      }
      createdBackend = Object.freeze({
        proxyTarget, advertisedOrigin, instanceId, caCertificate: ca.raw.toString('base64'), gateway,
        tlsStatus, renewTls, close,
      })
      gatewayCleanup = Object.freeze({ close })
      return createdBackend
    }
    try {
      if (tlsManager !== undefined) {
        return await tlsManager.withPrepared({ endpointId, signal }, activatePrepared)
      }
      if (signal?.aborted) throw new Error('iroh_gateway_start_cancelled')
      return await activatePrepared(undefined)
    } catch (error) {
      if (cleanupNeeded) {
        try { await gatewayCleanup.close() }
        catch (cleanupError) { throw cleanupFailure([error, cleanupError], gatewayCleanup) }
      }
      throw error
    }
  }
}
