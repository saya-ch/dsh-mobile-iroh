import { URL } from 'node:url'

const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
])

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1'])

const normalizedHostname = (hostname) => hostname.startsWith('[') && hostname.endsWith(']')
  ? hostname.slice(1, -1)
  : hostname

const asLoopbackTarget = (value) => {
  const target = value instanceof URL ? new URL(value.href) : new URL(value)
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('gateway target must use HTTP or HTTPS')
  if (!LOOPBACK_HOSTS.has(normalizedHostname(target.hostname))) throw new Error('gateway target must be an explicit loopback address')
  if (target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
    throw new Error('gateway target must be an origin')
  }
  return target
}

const pathUrl = (target, path) => {
  if (typeof path !== 'string' || path.length === 0 || !path.startsWith('/')
    || path.startsWith('//') || path.includes('\\') || path.includes('://')) {
    throw new Error('invalid gateway path')
  }
  const result = new URL(path, target)
  if (result.origin !== target.origin) throw new Error('invalid gateway path')
  return result
}

const headerRecord = (headers) => {
  if (headers === undefined) return {}
  const result = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower)) continue
    if (typeof value !== 'string' && !Array.isArray(value)) throw new Error('invalid gateway header')
    result[name] = Array.isArray(value) ? value.join(', ') : value
  }
  return result
}

const boundedBody = async (response, maximum) => {
  const declared = response.headers.get('content-length')
  if (declared !== null && Number.isSafeInteger(Number(declared)) && Number(declared) > maximum) {
    throw new Error('gateway response too large')
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maximum) throw new Error('gateway response too large')
  return bytes
}

/**
 * Create the host-side transport seam used by an iroh sidecar.
 *
 * The target is supplied by the plugin, not by a peer. Requests retain caller
 * authentication headers and cookies; this adapter never creates credentials
 * or disables DSH Mobile gateway policy.
 */
export function createGatewayAdapter({ target, fetchImpl = globalThis.fetch, maxRequestBytes = 8 * 1024 * 1024, maxResponseBytes = 16 * 1024 * 1024 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required')
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0) throw new Error('invalid max request bytes')
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) throw new Error('invalid max response bytes')
  const origin = asLoopbackTarget(target)

  return Object.freeze({
    origin: origin.origin,
    /** Forward one authenticated HTTP request to the plugin-owned gateway. */
    async forwardHttp({ method = 'GET', path, headers, body, signal } = {}) {
      if (typeof method !== 'string' || !/^[A-Z]+$/u.test(method)) throw new Error('invalid gateway method')
      if (body !== undefined && body !== null && typeof body !== 'string' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
        throw new Error('invalid gateway body')
      }
      if (body !== undefined && body !== null && Buffer.byteLength(body) > maxRequestBytes) throw new Error('gateway request too large')
      const response = await fetchImpl(pathUrl(origin, path), {
        method,
        headers: headerRecord(headers),
        ...(body === undefined || body === null ? {} : { body }),
        redirect: 'manual',
        signal,
      })
      const bytes = await boundedBody(response, maxResponseBytes)
      return Object.freeze({
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: bytes,
      })
    },
    /** Build a validated WebSocket URL; the sidecar owns the actual upgrade. */
    websocketUrl(path) {
      const url = pathUrl(origin, path)
      url.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:'
      return url.href
    },
  })
}

export { asLoopbackTarget }
