import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import { join } from 'node:path'
import { createSidecarFixtureRoot, firstPartyExecutable, startHostAndPhone, startPhone, waitForSidecarEvent } from './first-party-fixture.mjs'

const executable = process.env.DSH_IROH_HOST_BIN ?? firstPartyExecutable
const ownedRoot = await createSidecarFixtureRoot()
const root = ownedRoot.directory
const sockets = new Set()
let fixture, extraPhone, target
const bounded = async (promise, milliseconds, message) => {
  let timer
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
const payload = Buffer.from([0, 1, 2, 42, 127, 128, 255])
const http = (origin, path, body) => new Promise((resolve, reject) => {
  const url = new URL(path, origin)
  const outgoing = request(url, { agent: false, method: body === undefined ? 'GET' : 'POST', headers: { cookie: 'device=smoke', origin: 'https://foreign.invalid', 'x-smoke': 'unchanged' } }, (response) => {
    const chunks = []
    response.on('data', (chunk) => chunks.push(chunk))
    response.once('error', reject)
    response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }))
  })
  outgoing.setTimeout(5000, () => outgoing.destroy(new Error('HTTP smoke timeout')))
  outgoing.once('error', reject)
  outgoing.end(body)
})

const websocket = (origin) => new Promise((resolve, reject) => {
  const url = new URL(origin), socket = connect(Number(url.port), url.hostname)
  const key = 'MDEyMzQ1Njc4OWFiY2RlZg=='
  const expected = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
  let pending = Buffer.alloc(0), upgraded = false, finished = false
  const close = () => socket.destroy()
  const fail = (error) => { finished = true; close(); reject(error) }
  socket.setTimeout(5000, () => fail(new Error('WebSocket smoke timeout')))
  socket.once('error', fail)
  socket.once('close', () => { if (!finished) fail(new Error('WebSocket closed before echo')) })
  socket.once('connect', () => socket.write(`GET /ws HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: https://foreign.invalid\r\nCookie: device=smoke\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`))
  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk])
    if (pending.length > 16384) { fail(new Error('WebSocket response exceeded budget')); return }
    if (!upgraded) {
      const split = pending.indexOf('\r\n\r\n')
      if (split === -1) return
      const headers = pending.subarray(0, split).toString('ascii')
      if (!headers.startsWith('HTTP/1.1 101 ') || !headers.includes(`Sec-WebSocket-Accept: ${expected}`)) { fail(new Error('WebSocket upgrade mismatch')); return }
      pending = pending.subarray(split + 4); upgraded = true
      const mask = Buffer.from([1, 2, 3, 4]), bytes = Buffer.from('quic-frame')
      const encoded = Buffer.from(bytes.map((byte, index) => byte ^ mask[index % 4]))
      socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | bytes.length]), mask, encoded]))
    }
    if (upgraded && pending.length >= 2) {
      const length = pending[1] & 127
      if (pending.length < length + 2) return
      if (pending[0] !== 0x81 || (pending[1] & 128) !== 0 || pending.subarray(2, 2 + length).toString() !== 'quic-frame') { fail(new Error('WebSocket frame mismatch')); return }
      finished = true; close(); resolve()
    }
  })
})

try {
  target = createServer((incoming, response) => {
    const chunks = []
    incoming.on('data', (chunk) => chunks.push(chunk))
    incoming.on('end', () => {
      if (incoming.headers.cookie !== 'device=smoke' || incoming.headers.origin !== 'https://foreign.invalid' || incoming.headers['x-smoke'] !== 'unchanged') {
        response.writeHead(400); response.end('headers were not preserved'); return
      }
      if (incoming.url === '/echo') {
        response.setHeader('Set-Cookie', ['one=1; HttpOnly', 'two=2; SameSite=Strict'])
        response.end(Buffer.concat(chunks))
      } else response.end(payload)
    })
  })
  target.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  target.on('upgrade', (incoming, socket) => {
    if (incoming.headers.cookie !== 'device=smoke' || incoming.headers.origin !== 'https://foreign.invalid') { socket.destroy(); return }
    const accept = createHash('sha1').update(`${incoming.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length < 6) return
      const length = buffer[1] & 127
      if (length > 125 || !(buffer[1] & 128)) { socket.destroy(); return }
      if (buffer.length < length + 6) return
      const mask = buffer.subarray(2, 6), bytes = Buffer.from(buffer.subarray(6, 6 + length))
      for (let index = 0; index < bytes.length; index += 1) bytes[index] ^= mask[index % 4]
      socket.end(Buffer.concat([Buffer.from([0x81, bytes.length]), bytes]))
    })
  })
  await new Promise((resolve, reject) => { target.once('error', reject); target.listen(0, '127.0.0.1', resolve) })
  fixture = await startHostAndPhone({ executable, dataDir: root, proxyTarget: `http://127.0.0.1:${target.address().port}` })
  const bytes = await http(fixture.localAddress, '/bytes')
  assert.equal(bytes.status, 200); assert.deepEqual(bytes.body, payload)
  const echoed = await http(fixture.localAddress, '/echo', payload)
  assert.deepEqual(echoed.body, payload); assert.deepEqual(echoed.headers['set-cookie'], ['one=1; HttpOnly', 'two=2; SameSite=Strict'])
  await websocket(fixture.localAddress)
  const paired = await waitForSidecarEvent(fixture.host, (event) => event.type === 'pairing-done')
  await fixture.phone.stop()
  extraPhone = await startPhone({ executable, dataDir: join(root, 'phone'), endpointId: fixture.endpointId, peerAddresses: fixture.peerAddresses })
  assert.deepEqual((await http(extraPhone.localAddress, '/bytes')).body, payload)
  await assert.rejects(startPhone({ executable, dataDir: join(root, 'unknown-phone'), endpointId: fixture.endpointId, peerAddresses: fixture.peerAddresses }), /phone exited/)
  fixture.host.send({ version: 1, type: 'device-forget', id: paired.peer })
  await bounded(extraPhone.closed, 5000, 'revoked phone did not disconnect')
  await assert.rejects(http(extraPhone.localAddress, '/bytes'))
  await assert.rejects(startPhone({ executable, dataDir: join(root, 'phone'), endpointId: fixture.endpointId, peerAddresses: fixture.peerAddresses }), /phone exited/)
  fixture.host.send({ version: 1, type: 'device-list' })
  const devices = await waitForSidecarEvent(fixture.host, (event) => event.type === 'devices' && event.devices.length === 0)
  assert.equal(devices.devices.length, 0)
  console.log(JSON.stringify({ status: 'passed', implementation: 'first-party', topology: 'local-only explicit-address QUIC', pairing: true, persistedReconnect: true, httpBytes: true, cookiesAndOriginPreserved: true, websocketFrames: true, unknownPeerDenied: true, revocation: true, modelRequests: 0 }))
} finally {
  const errors = []
  try { await extraPhone?.stop() } catch (error) { errors.push(error) }
  try { await fixture?.close() } catch (error) { errors.push(error) }
  for (const socket of sockets) socket.destroy()
  if (target !== undefined) await new Promise((resolve) => target.close(() => resolve()))
  await ownedRoot.cleanup()
  if (errors.length > 0) throw new AggregateError(errors, 'first-party smoke cleanup failed')
}
