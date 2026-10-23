import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { collectInventory } from './dependency-inventory.mjs'

const LICENSE_NAME = /^(?:licen[cs]e|copying|notice|copyright)(?:s|[._-].*)?$/iu
const sourceHash = bytes => createHash('sha256').update(bytes).digest('hex')

/** Collect source-distributed legal notices without following links or copying implementation files. */
export async function packageLicenseFiles(directory, declaredFile) {
  const selected = new Set()
  async function inspect(path, depth) {
    const entry = await lstat(path)
    if (entry.isSymbolicLink()) throw new Error('release_license_symlink')
    if (entry.isFile()) {
      if (entry.size === 0 || entry.size > 2 * 1024 * 1024) throw new Error('release_license_file_size')
      selected.add(path)
    } else if (entry.isDirectory()) {
      if (depth > 8) throw new Error('release_license_directory_depth')
      for (const child of await readdir(path)) await inspect(join(path, child), depth + 1)
    }
  }
  for (const name of await readdir(directory)) if (LICENSE_NAME.test(name)) await inspect(join(directory, name), 0)
  if (declaredFile) {
    const path = resolve(directory, declaredFile)
    const local = relative(directory, path)
    if (local.startsWith('..') || resolve(directory, local) !== path) throw new Error('release_license_path_escape')
    await inspect(path, 0)
  }
  const files = []
  for (const path of [...selected].sort()) {
    const bytes = await readFile(path)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (text.includes('\0')) throw new Error('release_license_not_text')
    files.push({ file: relative(directory, path).replaceAll('\\', '/'), sha256: sourceHash(bytes), text })
  }
  return files
}

/** Check a pinned legal-text response before it can be distributed. */
export function verifyLicenseSource(bytes, pin) {
  if (bytes.length < 100 || bytes.length > 2 * 1024 * 1024 || sourceHash(bytes) !== pin.sha256) throw new Error('release_license_source_hash')
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

/** Bundle original complete Cargo license/notice files for the supported Host and JNI dependency sets. */
export async function releaseNotices(root, metadata, inventory = collectInventory(metadata)) {
  const pins = JSON.parse(await readFile(join(root, 'scripts/release-license-sources.json'), 'utf8'))
  const packages = []
  const sections = ['THIRD-PARTY SOFTWARE NOTICES',
    'This distribution includes the following Rust dependencies. Original license and notice texts are reproduced below.',
    'The dependency list includes build-time dependencies for the supported Windows x64, Linux x64, Android arm64 and Android x64 targets. It is not a claim that every listed library is linked into every artifact.', '']
  for (const item of inventory) {
    if (item.source === 'workspace') continue
    const original = metadata.packages.find(pkg => pkg.name === item.name && pkg.version === item.version && pkg.source === item.source)
    const licenses = await packageLicenseFiles(dirname(original.manifest_path), original.license_file)
    if (licenses.length === 0) {
      const pin = pins[`${item.name}@${item.version}`]
      if (!pin || !/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[a-f0-9]{40}\//u.test(pin.url)
        && pin.url !== 'https://www.apache.org/licenses/LICENSE-2.0') throw new Error(`release_license_text_missing:${item.name}@${item.version}`)
      const response = await fetch(pin.url, { redirect: 'error', signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`release_license_fetch_failed:${item.name}@${item.version}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      licenses.push({ file: 'upstream-license', sourceUrl: pin.url, sha256: pin.sha256, text: verifyLicenseSource(bytes, pin),
        ...(pin.selection ? { selection: pin.selection } : {}) })
    }
    packages.push({ name: item.name, version: item.version, licenseExpression: item.licenseExpression,
      source: item.source, repository: item.repository, licenses: licenses.map(({ text: _text, ...file }) => file) })
    sections.push(`========== ${item.name} ${item.version} ==========`, `Declared license: ${item.licenseExpression ?? 'see supplied license file'}`,
      ...(original.authors?.length ? [`Authors as declared upstream: ${original.authors.join('; ')}`] : []),
      ...(item.repository ? [`Source: ${item.repository}`] : []))
    for (const file of licenses) sections.push(`--- ${file.file} ---`, ...(file.sourceUrl ? [`Source: ${file.sourceUrl}`] : []),
      ...(file.selection ? [file.selection] : []), file.text.trimEnd(), '')
  }
  const directory = join(root, 'native')
  await mkdir(directory, { recursive: true })
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('release_license_output_symlink')
  for (const name of ['THIRD_PARTY_NOTICES.txt', 'dependencies.json']) {
    const existing = await lstat(join(directory, name)).catch(error => { if (error.code !== 'ENOENT') throw error })
    if (existing?.isSymbolicLink() || existing && !existing.isFile()) throw new Error('release_license_output_invalid')
  }
  await writeFile(join(directory, 'THIRD_PARTY_NOTICES.txt'), sections.join('\n') + '\n')
  const lockfileSha256 = sourceHash(await readFile(join(root, 'Cargo.lock')))
  await writeFile(join(directory, 'dependencies.json'), JSON.stringify({ schemaVersion: 1, lockfileSha256, packages }, null, 2) + '\n')
  return { packages: packages.length, licenseFiles: packages.reduce((sum, item) => sum + item.licenses.length, 0), lockfileSha256 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const selected = new Map()
  const allPackages = new Map()
  let metadata
  for (const [target, packageName] of [['x86_64-pc-windows-msvc', 'dsh-mobile-iroh-host'], ['x86_64-unknown-linux-gnu', 'dsh-mobile-iroh-host'],
    ['aarch64-linux-android', 'dsh-mobile-iroh-android-transport'], ['x86_64-linux-android', 'dsh-mobile-iroh-android-transport']]) {
    const { stdout } = await promisify(execFile)('cargo', ['metadata', '--format-version', '1', '--locked', '--offline', '--filter-platform', target], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
    })
    metadata = JSON.parse(stdout)
    for (const item of metadata.packages) allPackages.set(item.id, item)
    for (const item of collectInventory(metadata, [packageName])) selected.set(`${item.name}@${item.version}`, item)
  }
  console.log(JSON.stringify(await releaseNotices(root, { packages: [...allPackages.values()] }, [...selected.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en')))))
}
