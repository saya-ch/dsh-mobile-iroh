import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { parsePackArguments, verifyBinaryHeader, createReleaseArchive } from './pack-release.mjs'

const LC_SEGMENT_64 = 0x19
const LC_CODE_SIGNATURE = 0x1d

/** Build a thin 64-bit little-endian Mach-O executable header with resolvable load commands. */
function macho({ cpuType, signed = false }) {
  const commands = [[LC_SEGMENT_64, 72]].concat(signed ? [[LC_CODE_SIGNATURE, 16]] : [])
  const bytes = Buffer.alloc(32 + commands.reduce((total, [, size]) => total + size, 0))
  bytes.writeUInt32LE(0xfeedfacf, 0)
  bytes.writeUInt32LE(cpuType, 4)
  bytes.writeUInt32LE(0x00000003, 8)
  bytes.writeUInt32LE(0x2, 12)
  bytes.writeUInt32LE(commands.length, 16)
  bytes.writeUInt32LE(commands.reduce((total, [, size]) => total + size, 0), 20)
  let offset = 32
  for (const [command, size] of commands) {
    bytes.writeUInt32LE(command, offset)
    bytes.writeUInt32LE(size, offset + 4)
    offset += size
  }
  return bytes
}

test('binary headers distinguish Linux x64, Windows PE and both Apple architectures', () => {
  const elf = Buffer.alloc(128); elf.write('7f454c46', 0, 'hex'); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(62, 18)
  const pe = Buffer.alloc(128); pe.write('MZ'); pe.writeUInt32LE(64, 60); pe.write('50450000', 64, 'hex'); pe.writeUInt16LE(0x8664, 68)
  const arm64 = macho({ cpuType: 0x0100000c, signed: true }), x64 = macho({ cpuType: 0x01000007 })
  assert.doesNotThrow(() => verifyBinaryHeader(elf, 'linux-x64'))
  assert.doesNotThrow(() => verifyBinaryHeader(pe, 'win32-x64'))
  assert.doesNotThrow(() => verifyBinaryHeader(arm64, 'darwin-arm64'))
  assert.doesNotThrow(() => verifyBinaryHeader(x64, 'darwin-x64'))
  assert.throws(() => verifyBinaryHeader(pe, 'linux-x64'), /target_mismatch/)
  assert.throws(() => verifyBinaryHeader(elf, 'win32-x64'), /target_mismatch/)
  assert.throws(() => verifyBinaryHeader(arm64, 'darwin-x64'), /target_mismatch/)
  assert.throws(() => verifyBinaryHeader(x64, 'darwin-arm64'), /target_mismatch/)
  assert.throws(() => verifyBinaryHeader(elf, 'darwin-arm64'), /target_mismatch/)
  assert.throws(() => verifyBinaryHeader(pe, 'darwin-x64'), /target_mismatch/)
  elf.writeUInt16LE(183, 18)
  assert.throws(() => verifyBinaryHeader(elf, 'linux-x64'), /target_mismatch/)
  assert.throws(() => verifyBinaryHeader(Buffer.alloc(2), 'win32-x64'), /target_mismatch/)
  assert.throws(() => verifyBinaryHeader(Buffer.alloc(64), 'freebsd-x64'), /unsupported/)
})

test('Apple arm64 artifacts must carry a code signature; Intel ones need not', () => {
  const unsignedArm64 = macho({ cpuType: 0x0100000c })
  assert.throws(() => verifyBinaryHeader(unsignedArm64, 'darwin-arm64'), /binary_unsigned/)
  assert.doesNotThrow(() => verifyBinaryHeader(macho({ cpuType: 0x01000007 }), 'darwin-x64'))
  const truncated = macho({ cpuType: 0x0100000c, signed: true }).subarray(0, 40)
  assert.throws(() => verifyBinaryHeader(truncated, 'darwin-arm64'), /target_mismatch/)
})

test('release archive preserves executable mode for every native binary on any packing OS', async t => {
  const root = await mkdtemp(join(tmpdir(), 'iroh-pack-mode-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'native'))
  const linux = 'native/dsh-mobile-iroh-host-linux-x64', darwin = 'native/dsh-mobile-iroh-host-darwin-arm64'
  for (const path of [linux, darwin]) await writeFile(join(root, path), 'test executable content', { mode: 0o644 })
  await writeFile(join(root, 'package.json'), '{}')
  const file = join(root, 'candidate.tgz')
  const entries = await createReleaseArchive(root, file, [linux, darwin, 'package.json'])
  assert.equal(entries.find(item => item.path === linux).mode, 0o755)
  assert.equal(entries.find(item => item.path === darwin).mode, 0o755)
  assert.equal(entries.find(item => item.path === 'package.json').mode, 0o644)
  await assert.rejects(createReleaseArchive(root, file, [linux, darwin, 'package.json']), /EEXIST/)
})

test('pack command requires an explicit absolute artifact for every supported target', () => {
  const output = resolve('artifacts/package')
  const complete = { '--windows': resolve('test.exe'), '--linux': resolve('test-linux'),
    '--darwin-x64': resolve('test-darwin-x64'), '--darwin-arm64': resolve('test-darwin-arm64'), '--output': output }
  const args = Object.entries(complete).flat()
  assert.deepEqual(parsePackArguments(args), { windows: complete['--windows'], linux: complete['--linux'],
    darwinX64: complete['--darwin-x64'], darwinArm64: complete['--darwin-arm64'], output })
  assert.throws(() => parsePackArguments([]), /Expected/)
  assert.throws(() => parsePackArguments(args.slice(0, 8)), /Expected/)
  assert.throws(() => parsePackArguments(args.slice(0, -1)), /Expected/)
  assert.throws(() => parsePackArguments(args.map(value => value === complete['--windows'] ? 'relative.exe' : value)), /Expected/)
  assert.throws(() => parsePackArguments(args.filter(value => value !== '--darwin-arm64' && value !== complete['--darwin-arm64'])), /Expected/)
})
