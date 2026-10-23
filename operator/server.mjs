import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { MAX_PAIRING_DESCRIPTOR_BYTES, MAX_PAIRING_LIFETIME_MS } from '../integration/pairing-descriptor.mjs'

const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
])
const ID = /^[a-f0-9]{64}$/u
const TOKEN = /^[A-Za-z0-9_-]{43}$/u
const MAX_BODY = 12_288
const OPERATOR_FAULT = Symbol('operator fault')
const randomToken = () => randomBytes(32).toString('base64url')
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const fail = (status, code) => Object.assign(new Error(code), { status, code, [OPERATOR_FAULT]: true })
const keys = (value, expected) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === expected.sort().join(',')
const safeString = (value, max = 256) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value)

function safeStatus(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.enabled !== 'boolean'
    || !['off', 'starting', 'connecting', 'ready', 'error', 'stopping', 'unconfigured'].includes(raw.state)) throw fail(502, 'invalid_owner_status')
  const result = { enabled: raw.enabled, state: raw.state }
  if (ID.test(raw.endpointId ?? '')) result.endpointId = raw.endpointId
  if (typeof raw.configured === 'boolean') result.configured = raw.configured
  if (Number.isInteger(raw.localPort) && raw.localPort >= 1024 && raw.localPort <= 65535) result.localPort = raw.localPort
  if (typeof raw.localOnly === 'boolean') result.localOnly = raw.localOnly
  if (/^[a-z][a-z0-9_]{0,79}$/u.test(raw.errorCode ?? '')) result.errorCode = raw.errorCode
  if (/^[a-z][a-z0-9_]{0,79}$/u.test(raw.controlErrorCode ?? '')) result.controlErrorCode = raw.controlErrorCode
  if (typeof raw.origin === 'string') {
    try { const url = new URL(raw.origin); if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/') result.origin = url.origin } catch { /* Invalid display metadata is omitted. */ }
  }
  if (raw.tls && ['missing', 'valid', 'expiring', 'expired', 'error'].includes(raw.tls.state)) {
    result.tls = { state: raw.tls.state, renewable: raw.tls.renewable === true }
    if (Number.isSafeInteger(raw.tls.notAfter)) result.tls.notAfter = raw.tls.notAfter
  }
  return result
}

function safePeers(raw) {
  if (!Array.isArray(raw) || raw.length > 256) throw fail(502, 'invalid_owner_peers')
  return raw.map((peer) => {
    if (!ID.test(peer?.id ?? '') || !safeString(peer.name, 128) || [...peer.name].length > 64 || typeof peer.online !== 'boolean'
      || !(typeof peer.paired_at === 'string' && /^unix:\d{1,20}$/u.test(peer.paired_at))) throw fail(502, 'invalid_owner_peers')
    return { id: peer.id, name: peer.name, online: peer.online, paired_at: peer.paired_at }
  })
}

function configuration(body) {
  if (!keys(body, ['version', 'upstreamAuthenticatedUrl', 'localPort', 'localOnly']) || body.version !== 1
    || !safeString(body.upstreamAuthenticatedUrl, 8192) || !Number.isInteger(body.localPort)
    || body.localPort < 1024 || body.localPort > 65535 || typeof body.localOnly !== 'boolean') throw fail(400, 'invalid_configuration')
  let url
  try { url = new URL(body.upstreamAuthenticatedUrl) } catch { throw fail(400, 'invalid_upstream_url') }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.hash || !url.searchParams.get('token')) throw fail(400, 'invalid_upstream_url')
  return body
}

async function readBody(request) {
  if (request.headers['content-type'] !== 'application/json' || request.headers['content-encoding'] !== undefined
    || request.headers['transfer-encoding'] !== undefined) throw fail(400, 'invalid_json_request')
  const length = request.headers['content-length']
  if (length !== undefined && (!/^\d{1,5}$/u.test(length) || Number(length) > MAX_BODY)) throw fail(413, 'request_too_large')
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY) throw fail(413, 'request_too_large')
    chunks.push(chunk)
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    const value = JSON.parse(text)
    // Every supported request is a flat object. Duplicate member names are
    // rejected rather than letting JSON.parse silently select the last value.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const names = [...text.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/gu)].map((match) => JSON.parse(`"${match[1]}"`))
      if (new Set(names).size !== names.length) throw new Error('duplicate_json_member')
    }
    return value
  } catch { throw fail(400, 'invalid_json_request') }
}

/**
 * Start one IPv4-loopback operator page. The caller owns the supplied Host
 * owner and closes it separately after this server. No credentials are logged
 * or persisted here. renderQr returns a PNG data URL, never executable HTML.
 */
export async function createOperatorServer({ owner, renderQr, now = () => Date.now(),
  sessionLifetimeMs = 15 * 60_000, launchLifetimeMs = 60_000, operationTimeoutMs = 30_000,
} = {}) {
  const methods = ['status', 'configure', 'start', 'stop', 'reconnect', 'openPairing', 'listPeers', 'forgetPeer', 'renewTls']
  if (!owner || methods.some((method) => typeof owner[method] !== 'function') || typeof renderQr !== 'function'
    || typeof now !== 'function' || ![sessionLifetimeMs, launchLifetimeMs, operationTimeoutMs].every((value) => Number.isSafeInteger(value) && value >= 100 && value <= 3_600_000)) throw fail(400, 'invalid_operator_options')
  const assets = new Map(await Promise.all([...ASSETS].map(async ([route, [file, type]]) => [route, { body: await readFile(new URL(`./web/${file}`, import.meta.url)), type }])))
  let launchToken = randomToken()
  const launchExpires = now() + launchLifetimeMs
  const cookieName = `dsh_operator_${randomBytes(12).toString('hex')}`
  let session
  let origin
  let closed = false
  let closeTask
  let pairing
  let pairingTimer
  let pairingGeneration = 0
  let pairingBusy = false
  let pairingAbort
  let ownerBusy = false
  let stopping = false
  const operations = new Set()
  const sockets = new Set()

  const clearPairing = async (cancelOwner = true) => {
    pairingGeneration += 1
    pairing = undefined
    clearTimeout(pairingTimer)
    pairingAbort?.abort()
    if (cancelOwner && typeof owner.cancelPairing === 'function') {
      const signal = AbortSignal.timeout(operationTimeoutMs)
      let remove
      try {
        await Promise.race([Promise.resolve().then(() => owner.cancelPairing({ signal })), new Promise((_, reject) => {
          remove = () => reject(fail(409, 'operator_operation_cancelled'))
          signal.addEventListener('abort', remove, { once: true })
        })])
      } finally { signal.removeEventListener('abort', remove) }
    }
  }
  const invoke = async (method, value, request, response) => {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), operationTimeoutMs)
    const cancel = () => { if (!response.writableEnded) abort.abort() }
    request.once('aborted', cancel)
    response.once('close', cancel)
    operations.add(abort)
    if (method === 'openPairing') pairingAbort = abort
    let removeAbort
    try {
      return await Promise.race([
        Promise.resolve().then(() => value === undefined ? owner[method]({ signal: abort.signal }) : owner[method](value, { signal: abort.signal })),
        new Promise((_, reject) => {
          removeAbort = () => reject(fail(409, 'operator_operation_cancelled'))
          abort.signal.addEventListener('abort', removeAbort, { once: true })
          if (abort.signal.aborted) removeAbort()
        }),
      ])
    } finally {
      clearTimeout(timer)
      abort.signal.removeEventListener('abort', removeAbort)
      request.removeListener('aborted', cancel)
      response.removeListener('close', cancel)
      operations.delete(abort)
      if (pairingAbort === abort) pairingAbort = undefined
    }
  }
  const authenticated = (request, csrf = true) => {
    if (!session || now() >= session.expiresAt) { session = undefined; pairing = undefined; throw fail(401, 'operator_session_expired') }
    const cookies = request.headers.cookie?.split(';').map((part) => part.trim().split('=')) ?? []
    const tokens = cookies.filter(([name]) => name === cookieName)
    if (tokens.length !== 1 || !same(tokens[0][1], session.token)) throw fail(401, 'operator_authentication_required')
    if (csrf && !same(request.headers['x-operator-csrf'], session.csrf)) throw fail(403, 'operator_csrf_rejected')
  }
  const send = (response, status, value, extra = {}) => {
    if (closed || response.destroyed) return
    if (status === 200 && (value.status || value.peers || value.qrImage || value.payload)
      && (!session || now() >= session.expiresAt)) {
      pairing = undefined
      throw fail(401, 'operator_session_expired')
    }
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extra })
    response.end(JSON.stringify(value))
  }
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 5000, keepAliveTimeout: 1000 }, async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
    try {
      if (closed || request.socket.remoteAddress !== '127.0.0.1') throw fail(403, 'operator_loopback_required')
      for (const header of ['host', 'origin', 'cookie', 'content-type', 'content-length', 'x-operator-csrf']) {
        if (request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === header).length > 1) throw fail(400, 'duplicate_request_header')
      }
      if (request.headers.host !== origin.slice('http://'.length)) throw fail(403, 'operator_host_rejected')
      if (request.headers.origin !== undefined && request.headers.origin !== origin) throw fail(403, 'operator_origin_rejected')
      if (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])) throw fail(403, 'operator_origin_rejected')
      if (request.method === 'OPTIONS') throw fail(403, 'operator_cors_rejected')
      if (typeof request.url !== 'string' || request.url.includes('?') || request.url.includes('#') || request.url.length > 128) throw fail(404, 'operator_route_not_found')
      const asset = assets.get(request.url)
      if (asset && request.method === 'GET') {
        if (request.headers['content-length'] || request.headers['transfer-encoding']) throw fail(400, 'unexpected_request_body')
        response.writeHead(200, { 'Content-Type': asset.type }); response.end(asset.body); return
      }
      const routes = ['/api/v1/session', '/api/v1/status', '/api/v1/configure', '/api/v1/start', '/api/v1/stop', '/api/v1/reconnect', '/api/v1/pairing', '/api/v1/pairing/cancel', '/api/v1/pairing/copy', '/api/v1/peers', '/api/v1/peers/forget', '/api/v1/tls/renew', '/api/v1/logout']
      if (!routes.includes(request.url)) throw fail(404, 'operator_route_not_found')
      if (request.method !== 'POST') throw fail(405, 'operator_method_rejected')
      if (request.headers.origin !== origin) throw fail(403, 'operator_origin_required')
      if (request.url !== '/api/v1/session') authenticated(request)
      const body = await readBody(request)
      if (request.url === '/api/v1/session') {
        if (keys(body, ['version', 'token']) && body.version === 1 && TOKEN.test(body.token) && launchToken && now() < launchExpires && same(body.token, launchToken)) {
          launchToken = undefined
          session = { token: randomToken(), csrf: randomToken(), expiresAt: now() + sessionLifetimeMs }
        } else if (keys(body, ['version']) && body.version === 1) authenticated(request, false)
        else throw fail(401, 'operator_launch_token_rejected')
        send(response, 200, { version: 1, csrf: session.csrf, expiresAt: session.expiresAt }, { 'Set-Cookie': `${cookieName}=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor((session.expiresAt - now()) / 1000)}` }); return
      }
      if (request.url === '/api/v1/configure') configuration(body)
      else if (request.url === '/api/v1/peers/forget') {
        if (!keys(body, ['version', 'id']) || body.version !== 1 || !ID.test(body.id ?? '')) throw fail(400, 'invalid_operator_peer')
      } else if (!keys(body, ['version']) || body.version !== 1) throw fail(400, 'invalid_operator_request')
      if (request.url === '/api/v1/status') { send(response, 200, { version: 1, status: safeStatus(await invoke('status', undefined, request, response)) }); return }
      if (request.url === '/api/v1/logout') {
        for (const abort of operations) abort.abort()
        await clearPairing(); session = undefined
        send(response, 200, { version: 1 }, { 'Set-Cookie': `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` }); return
      }
      if (request.url === '/api/v1/pairing/cancel') { await clearPairing(); send(response, 200, { version: 1 }); return }
      if (request.url === '/api/v1/pairing/copy') {
        if (!pairing || now() >= pairing.expiresAt) { pairing = undefined; throw fail(410, 'operator_pairing_expired') }
        send(response, 200, { version: 1, payload: pairing.payload, expiresAt: pairing.expiresAt }); return
      }
      if (request.url === '/api/v1/stop') {
        if (stopping) throw fail(409, 'operator_busy')
        stopping = true
        try {
          for (const abort of operations) abort.abort()
          // The stop owner closes the transport and its pairing window. A
          // separate failed window rotation must not prevent that containment.
          await clearPairing(false)
          await invoke('stop', undefined, request, response)
          send(response, 200, { version: 1, status: safeStatus(await invoke('status', undefined, request, response)) }); return
        } finally { stopping = false }
      }
      if (ownerBusy || stopping) throw fail(409, 'operator_busy')
      ownerBusy = true
      try {
        if (request.url === '/api/v1/pairing') {
          if (pairingBusy) throw fail(409, 'operator_pairing_busy')
          pairingBusy = true
          const generation = ++pairingGeneration
          pairing = undefined
          try {
            const raw = await invoke('openPairing', undefined, request, response)
            if (closed || generation !== pairingGeneration || response.destroyed) throw fail(409, 'operator_operation_cancelled')
            const expiresAt = raw?.descriptor?.expiresAt
            if (!Number.isSafeInteger(expiresAt) || expiresAt <= now() || expiresAt > now() + MAX_PAIRING_LIFETIME_MS
              || typeof raw.qrPayload !== 'string' || raw.qrPayload.length < 1 || Buffer.byteLength(raw.qrPayload) > MAX_PAIRING_DESCRIPTOR_BYTES) throw fail(502, 'invalid_owner_pairing')
            const rendered = await renderQr(raw.qrPayload)
            const qrImage = Buffer.isBuffer(rendered) || rendered instanceof Uint8Array ? `data:image/png;base64,${Buffer.from(rendered).toString('base64')}` : rendered
            if (!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/u.test(qrImage) || qrImage.length > 1_000_000) throw fail(502, 'invalid_qr_image')
            if (closed || generation !== pairingGeneration || response.destroyed || now() >= expiresAt) throw fail(409, 'operator_operation_cancelled')
            pairing = { payload: raw.qrPayload, expiresAt }
            clearTimeout(pairingTimer)
            pairingTimer = setTimeout(() => { pairing = undefined }, Math.max(1, expiresAt - now()))
            pairingTimer.unref?.()
            send(response, 200, { version: 1, expiresAt, qrImage })
          } finally { pairingBusy = false }
          return
        }
        const method = new Map([
          ['/api/v1/configure', 'configure'], ['/api/v1/start', 'start'], ['/api/v1/stop', 'stop'],
          ['/api/v1/reconnect', 'reconnect'], ['/api/v1/peers', 'listPeers'], ['/api/v1/peers/forget', 'forgetPeer'], ['/api/v1/tls/renew', 'renewTls'],
        ]).get(request.url)
        if (method === 'configure' && !['off', 'unconfigured'].includes(safeStatus(await invoke('status', undefined, request, response)).state)) throw fail(409, 'operator_stop_before_configuring')
        if (['configure', 'stop', 'reconnect', 'renewTls'].includes(method)) await clearPairing()
        const result = await invoke(method, method === 'configure' ? body : method === 'forgetPeer' ? body.id : undefined, request, response)
        send(response, 200, { version: 1, ...(method === 'listPeers' || method === 'forgetPeer' ? { peers: safePeers(result) } : { status: safeStatus(await invoke('status', undefined, request, response)) }) })
      } finally { ownerBusy = false }
    } catch (error) {
      // Owner messages/causes can contain upstream authorization or pairing
      // material. Only this module's fixed status codes cross HTTP.
      const status = error?.[OPERATOR_FAULT] === true ? error.status : 502
      send(response, status, { version: 1, error: error?.[OPERATOR_FAULT] === true ? error.code : 'operator_operation_failed' })
    }
  })
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  server.on('clientError', (_, socket) => socket.destroy())
  server.on('upgrade', (_, socket) => socket.destroy())
  server.on('checkContinue', (_, response) => { response.writeHead(417); response.end() })
  server.maxRequestsPerSocket = 100
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => { server.removeListener('error', reject); resolve() })
  })
  origin = `http://127.0.0.1:${server.address().port}`
  const launchUrl = `${origin}/#${launchToken}`
  return Object.freeze({
    origin, launchUrl,
    close() {
      if (closeTask) return closeTask
      closed = true; launchToken = undefined; session = undefined; pairing = undefined; pairingGeneration += 1; clearTimeout(pairingTimer)
      for (const abort of operations) abort.abort()
      closeTask = (async () => {
        const cleanup = clearPairing()
        for (const socket of sockets) socket.destroy()
        await Promise.all([server.listening ? new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) : undefined, cleanup])
      })().catch(() => { closeTask = undefined; throw fail(502, 'operator_cleanup_failed') })
      return closeTask
    },
  })
}
