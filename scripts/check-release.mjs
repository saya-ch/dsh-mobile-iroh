import { readFile, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { NATIVE_TARGETS, resolveNativeHostAt } from '../src/native-artifact.mjs'

/** Reject a publication plan that changes the experimental channel or installs executable hooks. */
export function validateReleaseManifest(pkg) {
  if (pkg.name !== 'dsh-mobile-iroh' || !/^0\.\d+\.\d+-alpha\.[1-9]\d*$/u.test(pkg.version)
    || pkg.private === true || pkg.type !== 'module' || pkg.main !== './plugin/index.mjs'
    || pkg.exports?.['.'] !== './plugin/index.mjs' || pkg.exports?.['./client'] !== './lib/client.js'
    || pkg.exports?.['./package.json'] !== './package.json'
    || pkg.publishConfig?.tag !== 'alpha' || pkg.publishConfig?.access !== 'public'
    || pkg.publishConfig?.registry !== 'https://registry.npmjs.org/'
    || pkg.repository?.url !== 'git+https://github.com/saya-ch/dsh-mobile-iroh.git'
    || ['preinstall', 'install', 'postinstall', 'prepublish', 'prepublishOnly', 'prepare'].some(key => Object.hasOwn(pkg.scripts ?? {}, key))
    || !Array.isArray(pkg.files) || new Set(pkg.files).size !== pkg.files.length
    || pkg.files.some(file => typeof file !== 'string' || file.includes('..') || /[\\*?]/u.test(file)
      || /(?:^|\/)(?:artifacts|test-support|experiments|tests|\.github|target)(?:\/|$)|\.test\.|smoke|fixture/iu.test(file))) {
    throw new Error('iroh_release_manifest_invalid')
  }
  return pkg
}

/** Packed contents must exactly match the reviewable whitelist plus npm's mandatory package manifest. */
export function validatePackedFiles(files, pkg) {
  const actual = files.map(item => typeof item === 'string' ? item : item.path).sort()
  const expected = [...new Set([...pkg.files, 'package.json'])].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('iroh_release_packed_files_mismatch')
  const linux = files.find(item => typeof item !== 'string' && item.path === `native/${NATIVE_TARGETS['linux-x64']}`)
  if (linux && (!Number.isInteger(linux.mode) || (linux.mode & 0o111) === 0)) throw new Error('iroh_release_linux_mode_invalid')
}

/** Require regular source files, both authenticated native targets, and real bundled license text. */
export async function checkRelease(root) {
  const pkg = validateReleaseManifest(JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')))
  const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'))
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version
    || JSON.stringify(lock.packages[''].dependencies) !== JSON.stringify(pkg.dependencies)) throw new Error('iroh_release_npm_lock_mismatch')
  for (const file of pkg.files) {
    const stat = await lstat(resolve(root, file))
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error(`iroh_release_file_invalid:${file}`)
  }
  for (const target of Object.keys(NATIVE_TARGETS)) {
    const [platform, arch] = target.split('-')
    await resolveNativeHostAt(root, platform, arch)
  }
  const notices = await readFile(resolve(root, 'native/THIRD_PARTY_NOTICES.txt'), 'utf8')
  const dependencies = JSON.parse(await readFile(resolve(root, 'native/dependencies.json'), 'utf8'))
  if (dependencies.lockfileSha256 !== createHash('sha256').update(await readFile(resolve(root, 'Cargo.lock'))).digest('hex')) {
    throw new Error('iroh_release_license_lock_mismatch')
  }
  if (!notices.includes('THIRD-PARTY SOFTWARE NOTICES') || notices.length < 1000 || dependencies.schemaVersion !== 1
    || !Array.isArray(dependencies.packages) || dependencies.packages.length < 10
    || dependencies.packages.some(item => !Array.isArray(item.licenses) || item.licenses.length === 0)) {
    throw new Error('iroh_release_license_notices_missing')
  }
  return pkg
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await checkRelease(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
  console.log('Release files, experimental npm channel, native hashes and license notices passed.')
}
