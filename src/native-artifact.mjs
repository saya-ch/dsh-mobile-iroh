import { createHash } from 'node:crypto'
import { lstat, open, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const NATIVE_TARGETS = Object.freeze({
  'win32-x64': 'dsh-mobile-iroh-host-win32-x64.exe',
  'linux-x64': 'dsh-mobile-iroh-host-linux-x64',
})
const MAX_BINARY_BYTES = 128 * 1024 * 1024
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',')
const fault = code => Object.assign(new Error(code), { code })

/** Validate the complete package-bound inventory; artifact paths are never supplied by metadata. */
export function validateNativeManifest(value, packageVersion) {
  if (!exactKeys(value, ['schemaVersion', 'packageVersion', 'artifacts']) || value.schemaVersion !== 1
    || value.packageVersion !== packageVersion || !exactKeys(value.artifacts, Object.keys(NATIVE_TARGETS))) {
    throw fault('iroh_native_manifest_invalid')
  }
  for (const [target, entry] of Object.entries(value.artifacts)) {
    if (!exactKeys(entry, ['file', 'bytes', 'sha256']) || entry.file !== NATIVE_TARGETS[target]
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 64 || entry.bytes > MAX_BINARY_BYTES
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256)) throw fault('iroh_native_manifest_invalid')
  }
  return value
}

/** Verify a package directory for release gates and installed-package tests. No download or compilation occurs. */
export async function resolveNativeHostAt(root, platform, arch) {
  const target = `${platform}-${arch}`
  if (!Object.hasOwn(NATIVE_TARGETS, target)) throw fault('iroh_native_platform_unsupported')
  const nativeDirectory = join(root, 'native')
  const directory = await lstat(nativeDirectory).catch(() => { throw fault('iroh_native_missing') })
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw fault('iroh_native_file_invalid')
  const manifestPath = join(nativeDirectory, 'manifest.json')
  const manifestStat = await lstat(manifestPath).catch(() => { throw fault('iroh_native_missing') })
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 4096) throw fault('iroh_native_manifest_invalid')
  let manifest
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    manifest = validateNativeManifest(JSON.parse(await readFile(manifestPath, 'utf8')), pkg.version)
  } catch { throw fault('iroh_native_manifest_invalid') }
  const expected = manifest.artifacts[target]
  const path = join(nativeDirectory, NATIVE_TARGETS[target])
  const before = await lstat(path).catch(() => { throw fault('iroh_native_missing') })
  if (!before.isFile() || before.isSymbolicLink() || before.size !== expected.bytes) throw fault('iroh_native_file_invalid')
  const file = await open(path, 'r').catch(() => { throw fault('iroh_native_missing') })
  try {
    const opened = await file.stat()
    if (!opened.isFile() || opened.size !== expected.bytes || opened.ino !== before.ino || opened.dev !== before.dev) throw fault('iroh_native_file_invalid')
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      bytes += chunk.length
      if (bytes > expected.bytes) throw fault('iroh_native_file_changed')
      hash.update(chunk)
    }
    if (hash.digest('hex') !== expected.sha256) throw fault('iroh_native_hash_mismatch')
    const after = await lstat(path)
    if (after.isSymbolicLink() || after.ino !== opened.ino || after.dev !== opened.dev || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs) throw fault('iroh_native_file_changed')
  } finally { await file.close() }
  if (process.platform !== 'win32' && platform !== 'win32' && (before.mode & 0o111) === 0) throw fault('iroh_native_not_executable')
  return path
}

/** Return the installed, checksum-verified Host for this platform; unsupported hosts fail closed. */
export async function resolveNativeHost() {
  return resolveNativeHostAt(dirname(dirname(fileURLToPath(import.meta.url))), process.platform, process.arch)
}
