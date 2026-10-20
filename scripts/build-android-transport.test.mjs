import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectElf, parseOptions, verifyApkEntries } from './build-android-transport.mjs'

function fixture({ machine = 183, alignment = 16_384n, relroEnd = 0x8000n } = {}) {
  const bytes = Buffer.alloc(64 + 56 * 2)
  bytes.set([127, 69, 76, 70, 2, 1])
  bytes.writeUInt16LE(3, 16)
  bytes.writeUInt16LE(machine, 18)
  bytes.writeBigUInt64LE(64n, 32)
  bytes.writeUInt16LE(56, 54)
  bytes.writeUInt16LE(2, 56)
  bytes.writeUInt32LE(1, 64)
  bytes.writeBigUInt64LE(alignment, 64 + 48)
  bytes.writeUInt32LE(0x6474e552, 120)
  bytes.writeBigUInt64LE(0x4000n, 120 + 16)
  bytes.writeBigUInt64LE(relroEnd - 0x4000n, 120 + 40)
  return bytes
}

test('native ELF acceptance includes architecture, 16 KB LOAD and RELRO', () => {
  assert.deepEqual(inspectElf(fixture(), 183), { machine: 183, loadAlignments: ['16384'] })
  assert.throws(() => inspectElf(fixture(), 62), /architecture/)
  assert.throws(() => inspectElf(fixture({ alignment: 4096n }), 183), /LOAD/)
  assert.throws(() => inspectElf(fixture({ relroEnd: 0x7000n }), 183), /RELRO/)
  assert.throws(() => inspectElf(Buffer.alloc(4), 183), /ELF64/)
})

test('build arguments reject unknown ABI, duplicate ABI and ambiguous flags', () => {
  assert.deepEqual(parseOptions([]).abis, ['arm64-v8a', 'x86_64'])
  assert.throws(() => parseOptions(['--abis', 'armeabi-v7a']), /ABI/)
  assert.throws(() => parseOptions(['--abis', 'arm64-v8a,arm64-v8a']), /ABI/)
  assert.throws(() => parseOptions(['--output']), /argument/)
  assert.throws(() => parseOptions(['--unlocked', 'true']), /argument/)
})

test('APK verification refuses missing, duplicate or unselected ABI libraries', () => {
  const arm = 'lib/arm64-v8a/libdsh_mobile_iroh_android_transport.so'
  const x86 = 'lib/x86_64/libdsh_mobile_iroh_android_transport.so'
  verifyApkEntries(['classes.dex', arm, x86], ['arm64-v8a', 'x86_64'])
  assert.throws(() => verifyApkEntries(['classes.dex'], ['arm64-v8a']), /exactly one/)
  assert.throws(() => verifyApkEntries([arm, arm], ['arm64-v8a']), /exactly one/)
  assert.throws(() => verifyApkEntries([arm, x86], ['arm64-v8a']), /unselected/)
})
