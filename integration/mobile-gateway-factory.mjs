import { X509Certificate } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { irohHostname, irohOrigin } from './origin-contract.mjs'

/**
 * Create a dedicated Mobile Gateway through its public exports, without changing
 * the production plugin or exporting DSH launch credentials to the sidecar.
 * The phone forwards TLS bytes unchanged; the certificate and key stay on the host.
 */
export function createIrohGatewayFactory({ mobile, endpointId, localPort, backendHost = '127.0.0.1', upstreamOrigin, upstreamAuthenticatedUrl, stateFile, tls }) {
  const advertisedOrigin = irohOrigin(endpointId, localPort)
  const hostname = irohHostname(endpointId)
  if (!['127.0.0.1', '::1'].includes(backendHost)) throw new Error('iroh gateway must bind an explicit loopback address')
  if (!isAbsolute(stateFile ?? '') || !tls || Object.keys(tls).sort().join(',') !== 'caFile,certFile,keyFile'
    || Object.values(tls).some(file => typeof file !== 'string' || !isAbsolute(file))) {
    throw new Error('iroh gateway requires explicit state and host-only TLS files')
  }
  if (!mobile || typeof mobile.parseGatewayConfig !== 'function' || typeof mobile.MobileAccessGateway !== 'function'
    || typeof mobile.JsonDeviceStore !== 'function') throw new Error('public DSH Mobile Gateway exports are required')

  return async function startIrohGateway() {
    const [caPem, leafPem] = await Promise.all([readFile(tls.caFile, 'utf8'), readFile(tls.certFile, 'utf8')])
    const ca = new X509Certificate(caPem)
    const leaf = new X509Certificate(leafPem)
    if (!ca.ca || leaf.ca || ca.subject !== ca.issuer || !ca.verify(ca.publicKey) || !leaf.verify(ca.publicKey)
      || leaf.checkHost(hostname, { wildcards: false, subject: 'never' }) !== hostname) {
      throw new Error('iroh gateway requires its own CA and an exact endpoint-hostname leaf certificate')
    }
    const now = Date.now()
    if ([ca, leaf].some(cert => Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) <= now)) {
      throw new Error('iroh gateway certificate is outside its validity period')
    }
    const instanceId = ca.fingerprint256.replaceAll(':', '').toLowerCase()
    const config = mobile.parseGatewayConfig({
      listenHost: backendHost, listenPort: Number(new URL(advertisedOrigin).port),
      publicAuthorities: [new URL(advertisedOrigin).host], allowedCidrs: [backendHost === '::1' ? '::1/128' : '127.0.0.1/32'],
      upstreamOrigin, stateFile, instanceId, pairingCaFile: tls.caFile,
      tls: { mode: 'provided', certFile: tls.certFile, keyFile: tls.keyFile }, discovery: false,
    })
    const gateway = new mobile.MobileAccessGateway(config, new mobile.JsonDeviceStore(stateFile), undefined, upstreamAuthenticatedUrl)
    try { await gateway.start() } catch (error) {
      try { await gateway.close() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'iroh gateway startup and cleanup failed') }
      throw error
    }
    const proxyTarget = `https://${backendHost === '::1' ? '[::1]' : backendHost}:${gateway.address().port}`
    return Object.freeze({
      proxyTarget, advertisedOrigin, instanceId, caCertificate: ca.raw.toString('base64'), gateway,
      close: () => gateway.close(),
    })
  }
}
