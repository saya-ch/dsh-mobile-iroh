import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { NATIVE_TARGETS, resolveNativeHostAt, validateNativeManifest } from './native-artifact.mjs'

async function fixture(t, { pending = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'iroh-native-package-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'native'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.1.0-alpha.1' }))
  const bytes = Buffer.alloc(128, 42)
  const manifest = { schemaVersion: 1, packageVersion: '0.1.0-alpha.1', artifacts: {} }
  if (pending.length !== 0) manifest.pendingTargets = pending
  for (const [target, file] of Object.entries(NATIVE_TARGETS)) {
    if (pending.includes(target)) continue
    await writeFile(join(root, 'native', file), bytes, { mode: 0o755 })
    manifest.artifacts[target] = { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }
  const save = () => writeFile(join(root, 'native', 'manifest.json'), JSON.stringify(manifest))
  await save()
  return { root, manifest, save }
}

test('installed native resolver verifies both declared platform files', async t => {
  const { root } = await fixture(t)
  assert.equal(await resolveNativeHostAt(root, 'win32', 'x64'), join(root, 'native', NATIVE_TARGETS['win32-x64']))
  assert.equal(await resolveNativeHostAt(root, 'linux', 'x64'), join(root, 'native', NATIVE_TARGETS['linux-x64']))
  assert.equal(await resolveNativeHostAt(root, 'darwin', 'x64'), join(root, 'native', NATIVE_TARGETS['darwin-x64']))
  assert.equal(await resolveNativeHostAt(root, 'darwin', 'arm64'), join(root, 'native', NATIVE_TARGETS['darwin-arm64']))
  await assert.rejects(resolveNativeHostAt(root, 'freebsd', 'x64'), /platform_unsupported/)
  await assert.rejects(resolveNativeHostAt(root, 'darwin', 'ia32'), /platform_unsupported/)
})

test('a declared pending target fails closed instead of resolving an absent binary', async t => {
  const { root } = await fixture(t, { pending: ['darwin-x64', 'darwin-arm64'] })
  assert.equal(await resolveNativeHostAt(root, 'linux', 'x64'), join(root, 'native', NATIVE_TARGETS['linux-x64']))
  await assert.rejects(resolveNativeHostAt(root, 'darwin', 'arm64'), /artifact_pending/)
  await assert.rejects(resolveNativeHostAt(root, 'darwin', 'x64'), /artifact_pending/)
})

test('native inventory rejects missing, unknown, traversal and different-version entries', async t => {
  const { manifest } = await fixture(t)
  for (const mutate of [m => { delete m.artifacts['linux-x64'] }, m => { m.extra = true },
    m => { m.artifacts['win32-x64'].file = '../host.exe' }, m => { m.packageVersion = '0.1.0' },
    m => { m.artifacts['linux-x64'].sha256 = '0'.repeat(63) }, m => { m.artifacts['linux-x64'].bytes = 129 * 1024 * 1024 },
    m => { m.pendingTargets = [] }, m => { m.pendingTargets = ['linux-x64'] },
    m => { m.pendingTargets = ['freebsd-x64'] }, m => { m.pendingTargets = ['darwin-x64'] },
    m => { m.pendingTargets = ['darwin-x64', 'darwin-x64'] },
    m => { m.pendingTargets = Object.keys(NATIVE_TARGETS) }, m => { m.pendingTargets = ['darwin-x64']; delete m.artifacts['darwin-arm64'] }]) {
    const changed = structuredClone(manifest); mutate(changed)
    assert.throws(() => validateNativeManifest(changed, '0.1.0-alpha.1'), /manifest_invalid/)
  }
})

test('native inventory accepts an explicitly pending target set and rejects a partial one', () => {
  const artifacts = Object.fromEntries(['win32-x64', 'linux-x64'].map(target => [target,
    { file: NATIVE_TARGETS[target], bytes: 128, sha256: 'a'.repeat(64) }]))
  const pending = { schemaVersion: 1, packageVersion: '0.1.0-alpha.1', pendingTargets: ['darwin-x64', 'darwin-arm64'], artifacts }
  assert.equal(validateNativeManifest(pending, '0.1.0-alpha.1'), pending)
  for (const target of ['darwin-x64', 'darwin-arm64']) {
    const complete = structuredClone(pending)
    complete.artifacts[target] = { file: NATIVE_TARGETS[target], bytes: 128, sha256: 'a'.repeat(64) }
    assert.throws(() => validateNativeManifest(complete, '0.1.0-alpha.1'), /manifest_invalid/)
  }
})

test('native resolver rejects missing files, changed bytes and oversized metadata', async t => {
  const { root, save } = await fixture(t)
  const file = join(root, 'native', NATIVE_TARGETS['win32-x64'])
  await writeFile(file, Buffer.alloc(128, 43))
  await assert.rejects(resolveNativeHostAt(root, 'win32', 'x64'), /hash_mismatch/)
  await rm(file)
  await assert.rejects(resolveNativeHostAt(root, 'win32', 'x64'), /native_missing/)
  await writeFile(join(root, 'native', 'manifest.json'), ' '.repeat(5000))
  await assert.rejects(resolveNativeHostAt(root, 'win32', 'x64'), /manifest_invalid/)
  await save()
})

test('native resolver rejects symlinked binary files', { skip: process.platform === 'win32' && 'Creating file symlinks needs Windows developer-mode privilege; Linux CI runs this case.' }, async t => {
  const { root } = await fixture(t)
  const file = join(root, 'native', NATIVE_TARGETS['linux-x64'])
  await rm(file)
  await symlink(NATIVE_TARGETS['win32-x64'], file)
  await assert.rejects(resolveNativeHostAt(root, 'linux', 'x64'), /file_invalid/)
})
