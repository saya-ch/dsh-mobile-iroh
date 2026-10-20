// Historical canonical-envelope study; actual QUIC messages live in tether-core.
export const PROTOCOL_VERSION = 1

const MAX_MESSAGE_BYTES = 64 * 1024
const MAX_ID_LENGTH = 128
const MAX_NONCE_LENGTH = 256
const MESSAGE_TYPES = new Set([
  'hello',
  'pair-start',
  'pair-complete',
  'open-stream',
  'close-stream',
  'approval',
  'decision',
])

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  return value
}

const assertText = (value, name, max) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`invalid_${name}`)
  }
}

const validate = (message) => {
  if (!isPlainObject(message)) throw new Error('invalid_message')
  const keys = Object.keys(message).sort()
  if (keys.join(',') !== 'nonce,payload,requestId,type,version') throw new Error('invalid_message_fields')
  if (message.version !== PROTOCOL_VERSION) throw new Error('unsupported_protocol_version')
  assertText(message.type, 'message_type', 32)
  if (!MESSAGE_TYPES.has(message.type)) throw new Error('unsupported_message_type')
  assertText(message.requestId, 'request_id', MAX_ID_LENGTH)
  assertText(message.nonce, 'nonce', MAX_NONCE_LENGTH)
  if (!isPlainObject(message.payload)) throw new Error('invalid_message_payload')
  return message
}

/** Encode one bounded, canonical control message. */
export function encodeControlMessage(message) {
  const normalized = validate({ ...message, payload: canonicalize(message.payload) })
  const encoded = JSON.stringify(canonicalize(normalized))
  if (Buffer.byteLength(encoded, 'utf8') > MAX_MESSAGE_BYTES) throw new Error('message_too_large')
  return encoded
}

/** Decode and validate one control message without accepting unknown fields. */
export function decodeControlMessage(line) {
  if (typeof line !== 'string' || Buffer.byteLength(line, 'utf8') > MAX_MESSAGE_BYTES) throw new Error('message_too_large')
  let value
  try { value = JSON.parse(line) } catch { throw new Error('invalid_message_json') }
  return Object.freeze(validate(value))
}

/** Small in-memory replay window used by one authenticated peer session. */
export class ReplayWindow {
  #entries = new Map()

  constructor({ now = () => Date.now(), ttlMs = 60_000, maxEntries = 256 } = {}) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new Error('invalid_replay_window')
    this.now = now
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
  }

  /** Return false for a nonce already accepted in the active window. */
  accept(nonce) {
    assertText(nonce, 'nonce', MAX_NONCE_LENGTH)
    const now = this.now()
    for (const [key, expiresAt] of this.#entries) if (expiresAt <= now) this.#entries.delete(key)
    if (this.#entries.has(nonce)) return false
    // Capacity pressure cannot shorten the promised replay window.
    if (this.#entries.size >= this.maxEntries) return false
    this.#entries.set(nonce, now + this.ttlMs)
    return true
  }
}

export { MAX_MESSAGE_BYTES }
