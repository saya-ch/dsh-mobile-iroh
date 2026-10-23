import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { parsePackArguments, verifyBinaryHeader, createReleaseArchive } from './pack-release.mjs'

test('binary headers distinguish Linux x64 from Windows PE and other architectures', () => {
  const elf = Buffer.alloc(128); elf.write('7f454c46', 0, 'hex'); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(62, 18)
  const pe = Buffer.alloc(128); pe.write('MZ'); pe.writeUInt32LE(64, 60); pe.write('50450000', 64, 'hex'); pe.writeUInt16LE(0x8664, 68)
  assert.doesNotThrow(() => verifyBinaryHeader(elf, 'linux-x64'))
  assert.doesNotThrow(() => verifyBinaryHeader(pe, 'win32-x64'))
  assert.throws(() => verifyBinaryHeader(pe, 'linux-x64'), /target_mismatch/)
  assert.throws(() => verifyBinaryHeader(elf, 'win32-x64'), /target_mismatch/)
  elf.writeUInt16LE(183, 18)
  assert.throws(() => verifyBinaryHeader(elf, 'linux-x64'), /target_mismatch/)
  assert.throws(() => verifyBinaryHeader(Buffer.alloc(2), 'win32-x64'), /target_mismatch/)
})

test('release archive preserves executable Linux mode on every packing OS and refuses overwrite', async t => {
  const root = await mkdtemp(join(tmpdir(), 'iroh-pack-mode-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'native'))
  const path = 'native/dsh-mobile-iroh-host-linux-x64'
  await writeFile(join(root, path), 'test executable content', { mode: 0o644 })
  await writeFile(join(root, 'package.json'), '{}')
  const file = join(root, 'candidate.tgz')
  const entries = await createReleaseArchive(root, file, [path, 'package.json'])
  assert.equal(entries.find(item => item.path === path).mode, 0o755)
  assert.equal(entries.find(item => item.path === 'package.json').mode, 0o644)
  await assert.rejects(createReleaseArchive(root, file, [path, 'package.json']), /EEXIST/)
})

test('pack command accepts explicit absolute artifacts and rejects implicit discovery', () => {
  const windows = resolve('test.exe'), linux = resolve('test-linux'), output = resolve('artifacts/package')
  assert.deepEqual(parsePackArguments(['--windows', windows, '--linux', linux, '--output', output]), { windows, linux, output })
  assert.throws(() => parsePackArguments([]), /Expected/)
  assert.throws(() => parsePackArguments(['--windows', 'relative.exe', '--linux', linux, '--output', output]), /Expected/)
})
