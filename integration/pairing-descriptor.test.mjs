import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, X509Certificate } from 'node:crypto'
import { decodePairingDescriptor, encodePairingDescriptor, MAX_PAIRING_DESCRIPTOR_BYTES, MAX_PAIRING_LIFETIME_MS, PairingDescriptorError, validatePairingDescriptor } from './pairing-descriptor.mjs'
import { irohOrigin } from './origin-contract.mjs'

// Real public P-256 certificates generated for these tests. Their private keys
// were discarded; no test loads the main repository or requires a crypto tool.
const CA = 'MIIBZjCCAQygAwIBAgIJIO3VUGW99Y1DMAoGCCqGSM49BAMCMCkxJzAlBgNVBAMTHklyb2ggZGVzY3JpcHRvciBwdWJsaWMgdGVzdCBDQTAeFw0yNjEwMjAxNzAyNDdaFw0yNzEwMjAxNzAyNDdaMCkxJzAlBgNVBAMTHklyb2ggZGVzY3JpcHRvciBwdWJsaWMgdGVzdCBDQTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABDVMJkRvYw3iJUN2X+RiEU8KtDgFyjUTFYTXAYhge0ztH9etj3n5x8JQIwacFPtcYN5IX1onmj5oRGfCNYxT4h2jHTAbMAwGA1UdEwQFMAMBAf8wCwYDVR0PBAQDAgEGMAoGCCqGSM49BAMCA0gAMEUCIDVY/juF8b+H95Qy8XG8SYGzioE/WH/4aFAJ7/0gr8g2AiEA9vQgbCAaBb6pEqfp3g6mAG0m8mNo6dTjIYzbq5APQno='
const NON_CA = 'MIIBYDCCAQagAwIBAgIJB5A9BWgyS2RDMAoGCCqGSM49BAMCMC4xLDAqBgNVBAMTI0lyb2ggZGVzY3JpcHRvciBub24tQ0EgdGVzdCBmaXh0dXJlMB4XDTI2MTAyMDE3MDI0N1oXDTI3MTAyMDE3MDI0N1owLjEsMCoGA1UEAxMjSXJvaCBkZXNjcmlwdG9yIG5vbi1DQSB0ZXN0IGZpeHR1cmUwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAQd0FWqQhQUmJB4SeEQtEkkD4jWVrg/523xO//mwGFoB0YViOY3+z7Ingir5AjsOWal3OkAa4vGC8G0cKDeicr9ow0wCzAJBgNVHRMEAjAAMAoGCCqGSM49BAMCA0gAMEUCIGYz01kTeokOtCd6jriHxgFMjOaB0mK0E4dqV/YuEUxCAiEAuSPImbr2Silf71ofgpO2ikkBafod2mguIwDVRkiTvog='
const INTERMEDIATE = 'MIIBcDCCARegAwIBAgIJZx7kG+2DB1AqMAoGCCqGSM49BAMCMCkxJzAlBgNVBAMTHklyb2ggZGVzY3JpcHRvciBwdWJsaWMgdGVzdCBDQTAeFw0yNjEwMjAxNzAyNDdaFw0yNzEwMjAxNzAyNDdaMDQxMjAwBgNVBAMTKUlyb2ggZGVzY3JpcHRvciBpbnRlcm1lZGlhdGUgdGVzdCBmaXh0dXJlMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEbAIahRW3DWaL44MUthPTHrMcXJ/l/l8yfWAjK/ale3bHFXQLCd1YdEf5a48kTaidXlhJHCcbkeW2NVIHpm+GPaMdMBswDAYDVR0TBAUwAwEB/zALBgNVHQ8EBAMCAQYwCgYIKoZIzj0EAwIDRwAwRAIgco9V+jzajd6BbVWyabrMtHfmwK/7l60O+qGz25KYlO0CIE3LQFbForYDnm13168787rAYxaGv/VgMUehu7IPY4mz'
const now = Date.parse('2026-10-20T17:03:00Z')
const endpointId = 'a'.repeat(64)
const fingerprint = (encoded) => createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('hex')
const fixture = (overrides = {}) => ({ version: 1, type: 'dsh-mobile-iroh-pairing', endpointId, origin: irohOrigin(endpointId), localPort: 25443,
  irohCode: '123456', gatewayToken: Buffer.alloc(32, 42).toString('base64url'), caCertificate: CA, instanceId: fingerprint(CA), expiresAt: now + 300000, ...overrides })
const rejects = (value, code, options = { now }) => assert.throws(() => validatePairingDescriptor(value, options), (error) => error instanceof PairingDescriptorError && error.code === code)

test('real self-signed CA descriptor round-trips with explicit port and canonical field order', () => {
  const descriptor = fixture()
  const encoded = encodePairingDescriptor(descriptor, { now })
  assert.ok(Buffer.byteLength(encoded) <= MAX_PAIRING_DESCRIPTOR_BYTES)
  assert.deepEqual(decodePairingDescriptor(encoded, { now }), descriptor)
  assert.ok(Object.isFrozen(decodePairingDescriptor(encoded, { now })))
  assert.equal(encoded, encodePairingDescriptor(Object.fromEntries(Object.entries(descriptor).reverse()), { now }))
  const ca = new X509Certificate(Buffer.from(CA, 'base64'))
  assert.equal(ca.ca, true); assert.equal(ca.verify(ca.publicKey), true)
})

test('unknown fields, missing port, version, type and object kinds fail closed', () => {
  const { localPort, ...missingPort } = fixture()
  for (const value of [null, [], missingPort, { ...fixture(), extra: 'ignored?' }, new Date()]) rejects(value, 'invalid_pairing_fields')
  rejects(fixture({ version: 2 }), 'unsupported_pairing_descriptor')
  rejects(fixture({ type: 'dsh-mobile-pairing' }), 'unsupported_pairing_descriptor')
})

test('duplicate JSON keys fail without imposing field order or whitespace', () => {
  const encoded = encodePairingDescriptor(fixture(), { now })
  const repeatedVersion = encoded.replace('"version":1,', '"version":2,"version":1,')
  assert.throws(() => decodePairingDescriptor(repeatedVersion, { now }), (error) => error.code === 'duplicate_pairing_fields')
  const formatted = JSON.stringify(Object.fromEntries(Object.entries(fixture()).reverse()), null, 2)
  assert.deepEqual(decodePairingDescriptor(formatted, { now }), fixture())
  const escapedKey = encoded.replace('"version"', '"\\u0076ersion"')
  assert.deepEqual(decodePairingDescriptor(escapedKey, { now }), fixture())
})

test('logical HTTPS origin must match full public identity and explicit fixed port', () => {
  for (const endpointId of ['x'.repeat(64), 'A'.repeat(64), 'a'.repeat(63)]) rejects(fixture({ endpointId }), 'invalid_pairing_endpoint')
  for (const localPort of [0, 443, 1023, 65536, 25443.5, '25443']) rejects(fixture({ localPort }), 'invalid_pairing_local_port')
  for (const origin of ['https://localhost:25443', irohOrigin('b'.repeat(64)), `${irohOrigin(endpointId)}/`, irohOrigin(endpointId, 25444), irohOrigin(endpointId).replace('https:', 'http:'), `${irohOrigin(endpointId)}?token=x`]) rejects(fixture({ origin }), 'invalid_pairing_origin')
  assert.equal(validatePairingDescriptor(fixture({ localPort: 25444, origin: irohOrigin(endpointId, 25444) }), { now }).localPort, 25444)
})

test('transport and gateway pairing secrets have exact canonical encodings', () => {
  for (const irohCode of ['', '12345', '1234567', '１２３４５６', 123456]) rejects(fixture({ irohCode }), 'invalid_iroh_pairing_code')
  for (const gatewayToken of ['', 'a'.repeat(42), 'a'.repeat(44), '/'.repeat(43), 'a'.repeat(43), 'A'.repeat(42) + 'B']) rejects(fixture({ gatewayToken }), 'invalid_gateway_pairing_token')
})

test('descriptor expiry is short, bounded, and checked on every decode', () => {
  for (const expiresAt of [now, now - 1, now + MAX_PAIRING_LIFETIME_MS + 1, Number.MAX_SAFE_INTEGER, 'soon', now + 0.5]) rejects(fixture({ expiresAt }), 'invalid_pairing_expiry')
  assert.equal(validatePairingDescriptor(fixture({ expiresAt: now + MAX_PAIRING_LIFETIME_MS }), { now }).expiresAt, now + MAX_PAIRING_LIFETIME_MS)
  const encoded = encodePairingDescriptor(fixture(), { now })
  assert.throws(() => decodePairingDescriptor(encoded, { now: now + 300001 }), (error) => error.code === 'invalid_pairing_expiry')
})

test('certificate requires one canonical DER value and a matching CA fingerprint', () => {
  for (const caCertificate of ['', 'bad!', `${CA}\n`, CA.slice(0, -1), 'AA==', Buffer.alloc(1537).toString('base64')]) rejects(fixture({ caCertificate }), caCertificate === 'AA==' ? 'invalid_pairing_ca_certificate' : 'invalid_pairing_ca_encoding')
  const appended = Buffer.concat([Buffer.from(CA, 'base64'), Buffer.from([0])]).toString('base64')
  rejects(fixture({ caCertificate: appended }), 'invalid_pairing_ca_certificate')
  rejects(fixture({ instanceId: 'b'.repeat(64) }), 'pairing_ca_fingerprint_mismatch')
  rejects(fixture({ instanceId: 'B'.repeat(64) }), 'invalid_pairing_instance_id')
})

test('a real non-CA or signed intermediate is not accepted as a self-signed root', () => {
  for (const caCertificate of [NON_CA, INTERMEDIATE]) rejects(fixture({ caCertificate, instanceId: fingerprint(caCertificate) }), 'pairing_ca_must_be_self_signed')
  const damaged = Buffer.from(CA, 'base64'); damaged[damaged.length - 1] ^= 1
  rejects(fixture({ caCertificate: damaged.toString('base64'), instanceId: fingerprint(damaged.toString('base64')) }), 'pairing_ca_must_be_self_signed')
})

test('CA validity must cover both scanning time and descriptor expiration', () => {
  const ca = new X509Certificate(Buffer.from(CA, 'base64'))
  const before = Date.parse(ca.validFrom) - 1000
  rejects(fixture({ expiresAt: before + 60000 }), 'pairing_ca_outside_validity', { now: before })
  const nearEnd = Date.parse(ca.validTo) - 1000
  rejects(fixture({ expiresAt: nearEnd + 60000 }), 'pairing_ca_outside_validity', { now: nearEnd })
})

test('malformed or oversized QR text never exposes pairing secrets in errors', () => {
  assert.equal(MAX_PAIRING_DESCRIPTOR_BYTES, 2200)
  assert.throws(() => decodePairingDescriptor('x'.repeat(MAX_PAIRING_DESCRIPTOR_BYTES + 1), { now }), (error) => error.code === 'pairing_descriptor_too_large')
  assert.throws(() => decodePairingDescriptor('{secret', { now }), (error) => error.code === 'invalid_pairing_json')
  const descriptor = fixture({ irohCode: 'not-secret-format' })
  assert.throws(() => validatePairingDescriptor(descriptor, { now }), (error) => !error.message.includes(descriptor.gatewayToken) && !error.message.includes(descriptor.irohCode))
})
