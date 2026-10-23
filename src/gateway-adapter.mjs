import { URL } from 'node:url'

const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
])
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1'])
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u
const normalizedHostname = (hostname) => hostname.startsWith('[') && hostname.endsWith(']')
  ? hostname.slice(1, -1) : hostname

/** Validate a plugin-selected target; peers cannot select a destination. */
export function asLoopbackTarget(value) {
  const target = value instanceof URL ? new URL(value.href) : new URL(value)
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('gateway target must use HTTP or HTTPS')
  if (!LOOPBACK_HOSTS.has(normalizedHostname(target.hostname))) throw new Error('gateway target must be an explicit loopback address')
  if (target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
    throw new Error('gateway target must be an origin')
  }
  return target
}

const pathUrl = (target, path) => {
  if (typeof path !== 'string' || path.length === 0 || path.length > 8192 || !path.startsWith('/')
    || path.startsWith('//') || /[\u0000-\u0020\u007f\\#]/u.test(path) || path.includes('://')) {
    throw new Error('invalid gateway path')
  }
  const result = new URL(path, target)
  if (result.origin !== target.origin || `${result.pathname}${result.search}` !== path) throw new Error('invalid gateway path')
  return result
}

const validatedHeaderPairs = (headers) => {
  if (headers === undefined) return []
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) throw new Error('invalid gateway headers')
  const pairs = []
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) throw new Error('invalid gateway header')
    const values = Array.isArray(value) ? value : [value]
    if (values.length === 0 || values.some((item) => typeof item !== 'string' || /[\u0000-\u001f\u007f]/u.test(item))) {
      throw new Error('invalid gateway header')
    }
    pairs.push([name.toLowerCase(), values])
  }
  return pairs
}

const cleanHeaders = (pairs) => {
  const excluded = new Set(HOP_BY_HOP_HEADERS)
  for (const [name, values] of pairs) {
    if (name !== 'connection') continue
    for (const token of values.join(',').split(',')) {
      const key = token.trim().toLowerCase()
      if (!HEADER_NAME.test(key)) throw new Error('invalid gateway connection header')
      excluded.add(key)
    }
  }
  const result = {}
  for (const [name, values] of pairs) {
    if (excluded.has(name)) continue
    if (name === 'set-cookie') result[name] = [...(result[name] ?? []), ...values]
    else {
      const separator = name === 'cookie' ? '; ' : ', '
      result[name] = result[name] === undefined ? values.join(separator) : `${result[name]}${separator}${values.join(separator)}`
    }
  }
  return result
}

const boundedBody = async (response, maximum, signal) => {
  if (response.body === null) return new Uint8Array()
  const declared = response.headers.get('content-length')
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maximum) {
    await response.body?.cancel()
    throw new Error('gateway response too large')
  }
  const reader = response.body.getReader()
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  const chunks = []
  let length = 0
  try {
    while (true) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      length += value.byteLength
      if (length > maximum) throw new Error('gateway response too large')
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    signal?.removeEventListener('abort', abort)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

/**
 * Buffered HTTP seam for bounded control/asset requests. HTTP streaming and
 * WebSocket byte streams remain owned by the Rust carrier, not this helper.
 * Cookies and Origin are forwarded unchanged: this helper grants no identity,
 * creates no credentials, and never turns a foreign Origin into a trusted one.
 */
export function createGatewayAdapter({ target, fetchImpl = globalThis.fetch, maxRequestBytes = 8 * 1024 * 1024, maxResponseBytes = 16 * 1024 * 1024 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required')
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0) throw new Error('invalid max request bytes')
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) throw new Error('invalid max response bytes')
  const origin = asLoopbackTarget(target)
  return Object.freeze({
    origin: origin.origin,
    /** Forward one request without following a redirect outside the gateway. */
    async forwardHttp({ method = 'GET', path, headers, body, signal } = {}) {
      if (typeof method !== 'string' || !/^[A-Z]+$/u.test(method) || ['CONNECT', 'TRACE'].includes(method)) throw new Error('invalid gateway method')
      if (body !== undefined && body !== null && typeof body !== 'string' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) throw new Error('invalid gateway body')
      if (body !== undefined && body !== null && Buffer.byteLength(body) > maxRequestBytes) throw new Error('gateway request too large')
      if (body !== undefined && body !== null && ['GET', 'HEAD'].includes(method)) throw new Error('gateway method cannot have a body')
      signal?.throwIfAborted()
      const response = await fetchImpl(pathUrl(origin, path), {
        method, headers: cleanHeaders(validatedHeaderPairs(headers)),
        ...(body === undefined || body === null ? {} : { body }), redirect: 'manual', signal,
      })
      const bytes = await boundedBody(response, maxResponseBytes, signal)
      const pairs = [...response.headers.entries()].filter(([name]) => name !== 'set-cookie')
        .map(([name, value]) => [name, [value]])
      const cookies = response.headers.getSetCookie()
      if (cookies.length !== 0) pairs.push(['set-cookie', cookies])
      const resultHeaders = cleanHeaders(pairs)
      // Fetch decodes content codings, so encoded lengths cannot be forwarded.
      const bodyless = method === 'HEAD' || [204, 205, 304].includes(response.status)
      if (!bodyless) {
        delete resultHeaders['content-encoding']
        resultHeaders['content-length'] = String(bytes.byteLength)
      }
      if (resultHeaders['set-cookie'] !== undefined) Object.freeze(resultHeaders['set-cookie'])
      return Object.freeze({ status: response.status, headers: Object.freeze(resultHeaders), body: bytes })
    },
    /** Validate the upgrade destination; the Rust carrier owns the handshake. */
    websocketUrl(path) {
      const url = pathUrl(origin, path)
      url.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:'
      return url.href
    },
  })
}
