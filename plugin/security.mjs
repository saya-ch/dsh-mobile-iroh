export const LAUNCH_PATH = '/api/dsh-mobile-iroh/launch'
export const ADMIN_HEADER = 'x-dsh-iroh-admin'

const fail = code => Object.assign(new Error(code),{ code })
const loopback = address => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'

/** The installed adapter supports an authenticated numeric-loopback HTTP Host. */
export function currentHostOrigin(webServer) {
  if (!['127.0.0.1','::1'].includes(webServer?.host) || webServer.protocol !== 'http:'
    || !Number.isInteger(webServer.port) || webServer.port < 1 || webServer.port > 65535) throw fail('iroh_loopback_http_host_required')
  return `http://${webServer.host === '::1' ? '[::1]' : webServer.host}:${webServer.port}`
}

/** Authenticate the local non-simple action before any process or browser effect. */
export function assertLaunchRequest(request,origin,connection) {
  if (request.method !== 'POST' || request.url !== LAUNCH_PATH || !loopback(request.socket?.remoteAddress)) throw fail('iroh_admin_rejected')
  for (const name of ['host','origin','cookie','content-type','content-length',ADMIN_HEADER]) {
    if (request.rawHeaders?.filter((value,index) => index % 2 === 0 && value.toLowerCase() === name).length > 1) throw fail('iroh_admin_rejected')
  }
  const headers = request.headers
  let requestOrigin
  try {
    const parsed = new URL(`http://${headers.host}`),upstream = new URL(origin)
    if (!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname) || parsed.port !== upstream.port
      || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw fail('iroh_admin_rejected')
    requestOrigin = parsed.origin
  } catch { throw fail('iroh_admin_rejected') }
  if (headers['content-type'] !== 'application/json'
    || headers['content-encoding'] !== undefined || headers['transfer-encoding'] !== undefined
    || headers['sec-fetch-site'] !== undefined && headers['sec-fetch-site'] !== 'same-origin'
    || headers.origin !== undefined && headers.origin !== requestOrigin
    || typeof connection?.requestRejection !== 'function' || connection.requestRejection(request) !== undefined) throw fail('iroh_admin_rejected')
  const marker = headers[ADMIN_HEADER]
  if (marker !== 'same-origin-json' && marker !== 'dsh-app://app') throw fail('iroh_admin_rejected')
  if (marker === 'dsh-app://app' && (headers.origin !== undefined || headers['sec-fetch-site'] !== undefined)) throw fail('iroh_admin_rejected')
}

/** A single fixed request schema avoids permissive duplicate-key JSON parsing. */
export async function readLaunchRequest(request,{ signal } = {}) {
  const length = request.headers['content-length']
  if (length !== undefined && (!/^\d{1,3}$/u.test(length) || Number(length) > 64)) throw fail('iroh_invalid_request')
  let text = '',size = 0
  const abort = () => request.destroy()
  signal?.throwIfAborted(); signal?.addEventListener('abort',abort,{ once:true })
  try {
    for await (const chunk of request) {
      size += chunk.length
      if (size > 64) throw fail('iroh_invalid_request')
      text += chunk.toString('utf8')
    }
    signal?.throwIfAborted()
    if (!/^\s*\{\s*"version"\s*:\s*1\s*\}\s*$/u.test(text)) throw fail('iroh_invalid_request')
  } finally { signal?.removeEventListener('abort',abort) }
}
