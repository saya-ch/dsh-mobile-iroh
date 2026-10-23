import assert from 'node:assert/strict'
import test from 'node:test'
import { irohHostname, irohOrigin, validateIrohOrigin } from './origin-contract.mjs'

test('full endpoint identity remains distinct beyond the first port-hash bytes', () => {
  const a = `abcd${'0'.repeat(60)}`
  const b = `abcd${'0'.repeat(59)}1`
  assert.notEqual(irohHostname(a), irohHostname(b))
  assert.notEqual(irohOrigin(a), irohOrigin(b))
  assert.ok(irohHostname(a).split('.').every(label => label.length <= 63))
  assert.equal(irohOrigin(a), `https://${irohHostname(a)}:25443`)
})

test('origin validation rejects another host, a changed port and URL decorations', () => {
  const id = 'a'.repeat(64)
  const origin = irohOrigin(id)
  assert.equal(validateIrohOrigin(origin, id), origin)
  for (const value of [irohOrigin('b'.repeat(64)), irohOrigin(id, 25444), `${origin}/`, `${origin}?token=x`, origin.replace('https:', 'http:')]) {
    assert.throws(() => validateIrohOrigin(value, id))
  }
})

test('endpoint and port input fail closed', () => {
  for (const id of ['', 'a'.repeat(63), 'A'.repeat(64), `${'a'.repeat(64)}.example.com`, null]) {
    assert.throws(() => irohHostname(id))
  }
  for (const port of [0, 443, 65536, 25443.5, '25443', NaN]) assert.throws(() => irohOrigin('a'.repeat(64), port))
})
