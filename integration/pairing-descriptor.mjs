import { createHash, X509Certificate } from 'node:crypto'
import { irohOrigin } from './origin-contract.mjs'

export const PAIRING_DESCRIPTOR_VERSION = 1
export const PAIRING_DESCRIPTOR_TYPE = 'dsh-mobile-iroh-pairing'
// Fits byte-mode QR at M correction, leaving headroom below its maximum symbol capacity.
export const MAX_PAIRING_DESCRIPTOR_BYTES = 2200
export const MAX_PAIRING_LIFETIME_MS = 10 * 60 * 1000
export const MAX_PAIRING_CA_BYTES = 1536
const FIELDS = Object.freeze(['version', 'type', 'endpointId', 'origin', 'localPort', 'irohCode', 'gatewayToken', 'caCertificate', 'instanceId', 'expiresAt'])
const HEX_ID = /^[a-f0-9]{64}$/u
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

/** Error messages never contain the descriptor, pairing code, or gateway token. */
export class PairingDescriptorError extends Error {
  constructor(code) { super(code); this.name = 'PairingDescriptorError'; this.code = code }
}
const reject = (code) => { throw new PairingDescriptorError(code) }

const validateCertificate = (value, instanceId, now, expiresAt) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(MAX_PAIRING_CA_BYTES / 3) * 4 || !BASE64.test(value)) reject('invalid_pairing_ca_encoding')
  const der = Buffer.from(value, 'base64')
  if (der.length === 0 || der.length > MAX_PAIRING_CA_BYTES || der.toString('base64') !== value) reject('invalid_pairing_ca_encoding')
  let ca
  try { ca = new X509Certificate(der) } catch { reject('invalid_pairing_ca_certificate') }
  // X509Certificate may accept a valid prefix. A QR contains exactly one DER
  // certificate, not a chain, PEM text, or valid DER followed by arbitrary bytes.
  if (!ca.raw.equals(der)) reject('invalid_pairing_ca_certificate')
  try {
    if (!ca.ca || ca.subject !== ca.issuer || !ca.verify(ca.publicKey)) reject('pairing_ca_must_be_self_signed')
  } catch (error) {
    if (error instanceof PairingDescriptorError) throw error
    reject('pairing_ca_must_be_self_signed')
  }
  const notBefore = Date.parse(ca.validFrom), notAfter = Date.parse(ca.validTo)
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || now < notBefore || expiresAt > notAfter) reject('pairing_ca_outside_validity')
  if (createHash('sha256').update(der).digest('hex') !== instanceId) reject('pairing_ca_fingerprint_mismatch')
}

/**
 * Validate QR transport material, not a DSH Session or persistent credential.
 * localPort is mandatory on the wire and must match the identity-derived HTTPS
 * Origin. The QR is sensitive: only the public CA may be retained or logged on
 * its own; neither pairing secret may be copied into logs or device-list text.
 *
 * Scanning this descriptor is the user's out-of-band trust action. A self-signed
 * CA does not independently authenticate a QR received from an untrusted party.
 */
export function validatePairingDescriptor(value, { now = Date.now() } = {}) {
  if (!Number.isSafeInteger(now) || now < 0) reject('invalid_pairing_clock')
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).sort().join(',') !== [...FIELDS].sort().join(',')) reject('invalid_pairing_fields')
  if (value.version !== PAIRING_DESCRIPTOR_VERSION || value.type !== PAIRING_DESCRIPTOR_TYPE) reject('unsupported_pairing_descriptor')
  if (typeof value.endpointId !== 'string' || !HEX_ID.test(value.endpointId)) reject('invalid_pairing_endpoint')
  if (!Number.isSafeInteger(value.localPort) || value.localPort < 1024 || value.localPort > 65535) reject('invalid_pairing_local_port')
  if (value.origin !== irohOrigin(value.endpointId, value.localPort)) reject('invalid_pairing_origin')
  if (typeof value.irohCode !== 'string' || !/^[0-9]{6}$/u.test(value.irohCode)) reject('invalid_iroh_pairing_code')
  if (typeof value.gatewayToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value.gatewayToken)
    || Buffer.from(value.gatewayToken, 'base64url').toString('base64url') !== value.gatewayToken) reject('invalid_gateway_pairing_token')
  if (typeof value.instanceId !== 'string' || !HEX_ID.test(value.instanceId)) reject('invalid_pairing_instance_id')
  if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt - now > MAX_PAIRING_LIFETIME_MS) reject('invalid_pairing_expiry')
  validateCertificate(value.caCertificate, value.instanceId, now, value.expiresAt)
  const descriptor = Object.fromEntries(FIELDS.map((field) => [field, value[field]]))
  if (Buffer.byteLength(JSON.stringify(descriptor), 'utf8') > MAX_PAIRING_DESCRIPTOR_BYTES) reject('pairing_descriptor_too_large')
  return Object.freeze(descriptor)
}

/** Encode a bounded canonical-field-order QR payload without implicit defaults. */
export function encodePairingDescriptor(value, options) {
  return JSON.stringify(validatePairingDescriptor(value, options))
}

/** Decode untrusted QR text, validating its expiry and public CA before use. */
export function decodePairingDescriptor(encoded, options) {
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > MAX_PAIRING_DESCRIPTOR_BYTES) reject('pairing_descriptor_too_large')
  let value
  try { value = JSON.parse(encoded) } catch { reject('invalid_pairing_json') }
  const descriptor = validatePairingDescriptor(value, options)
  // The accepted schema is one flat object of validated ASCII strings and
  // integers. Count key tokens only after that validation: JSON.parse otherwise
  // silently discards a repeated key, creating cross-parser ambiguity.
  const keys = encoded.match(/"(?:[^"\\]|\\[\s\S])*"\s*:/gu) ?? []
  if (keys.length !== FIELDS.length) reject('duplicate_pairing_fields')
  return descriptor
}
