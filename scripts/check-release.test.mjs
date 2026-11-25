import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { validateReleaseManifest, validatePackedFiles } from './check-release.mjs'
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const mode = path => path.startsWith('native/') && !path.endsWith('.exe') ? 0o755 : 0o644

test('release manifest restricts publication to the independent experimental package', () => {
  assert.equal(validateReleaseManifest(pkg), pkg)
  for (const mutate of [p => { p.publishConfig.tag = 'latest' }, p => { p.private = true },
    p => { p.version = '0.1.0' }, p => { p.scripts.install = 'curl installer' },
    p => { p.repository.url = 'git+https://github.com/saya-ch/dsh-mobile.git' },
    p => { p.files.push('integration/first-party-fixture.mjs') }, p => { p.files.push('native/*') },
    p => { p.files.push('artifacts/state.json') }]) {
    const changed = structuredClone(pkg); mutate(changed)
    assert.throws(() => validateReleaseManifest(changed), /manifest_invalid/)
  }
})

test('npm tarball inspection rejects missing binaries and unlisted source or secrets', () => {
  const files = [...pkg.files, 'package.json'].map(path => ({ path, mode: mode(path) }))
  assert.doesNotThrow(() => validatePackedFiles(files, pkg))
  assert.throws(() => validatePackedFiles(files.slice(1), pkg), /files_mismatch/)
  assert.throws(() => validatePackedFiles([...files, { path: '.env' }], pkg), /files_mismatch/)
  assert.throws(() => validatePackedFiles([...files, files[0]], pkg), /files_mismatch/)
  assert.throws(() => validatePackedFiles(files.map(file => ({ ...file, mode: 0o644 })), pkg), /executable_mode_invalid/)
  for (const target of ['darwin-x64', 'darwin-arm64']) {
    const path = `native/dsh-mobile-iroh-host-${target}`
    const entry = files.find(file => file.path === path)
    assert.ok(entry, `expected ${path} in the publication whitelist`)
    assert.throws(() => validatePackedFiles(files.map(file => file === entry ? { ...file, mode: 0o644 } : file), pkg), /executable_mode_invalid/)
  }
})
