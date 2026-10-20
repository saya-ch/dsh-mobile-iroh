/** Identity-derived browser origins for the raw TLS-over-iroh carrier. */
export const DEFAULT_IROH_LOCAL_PORT = 25443

/** Keep the full endpoint key in DNS-safe labels rather than a colliding port hash. */
export function irohHostname(endpointId) {
  if (typeof endpointId !== 'string' || !/^[a-f0-9]{64}$/u.test(endpointId)) {
    throw new Error('iroh endpoint id must be a lowercase 32-byte public key')
  }
  return `${endpointId.slice(0, 32)}.${endpointId.slice(32)}.iroh.localhost`
}

/** The local port is a deployment choice; changing it changes browser storage identity. */
export function irohOrigin(endpointId, localPort = DEFAULT_IROH_LOCAL_PORT) {
  if (!Number.isSafeInteger(localPort) || localPort < 1024 || localPort > 65535) {
    throw new Error('iroh local port must be from 1024 through 65535')
  }
  return `https://${irohHostname(endpointId)}:${localPort}`
}

/** Reject an Origin that does not belong to the selected cryptographic host identity. */
export function validateIrohOrigin(value, endpointId, localPort = DEFAULT_IROH_LOCAL_PORT) {
  const expected = irohOrigin(endpointId, localPort)
  if (value !== expected) throw new Error('iroh origin does not match the selected endpoint and local port')
  return expected
}
