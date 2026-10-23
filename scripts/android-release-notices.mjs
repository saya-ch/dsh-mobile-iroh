/** Generate APK legal notices from the resolved release classpath and target-specific Cargo graphs. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { inflateRawSync, crc32 } from 'node:zlib'
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { collectInventory } from './dependency-inventory.mjs'
import { packageLicenseFiles, verifyLicenseSource } from './release-notices.mjs'

const MAX_ARCHIVE = 128 * 1024 * 1024
const MAX_TEXT = 2 * 1024 * 1024
const MAX_LEGAL_TOTAL = 16 * 1024 * 1024
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const legalName = /^(?:licen[cs]e|copying|notice|copyright)(?:s|[._-].*)?$/iu

/** Read legal text and nested JARs in bounded ZIPs without extracting any pathname. */
export function archiveLicenseTexts(bytes, prefix = '', depth = 0) {
  if (bytes.length < 22 || bytes.length > MAX_ARCHIVE || depth > 2) throw new Error('android_license_archive_size')
  let end = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) throw new Error('android_license_archive_end')
  const count = bytes.readUInt16LE(end + 10), length = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16)
  if (count > 10000 || bytes.readUInt16LE(end + 8) !== count || start + length !== end) throw new Error('android_license_archive_directory')
  let cursor = start
  let collectedBytes = 0, nestedArchives = 0
  const files = [], names = new Set()
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('android_license_archive_entry')
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), checksum = bytes.readUInt32LE(cursor + 16)
    const compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24), nameLength = bytes.readUInt16LE(cursor + 28)
    const extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32), local = bytes.readUInt32LE(cursor + 42)
    if (cursor + 46 + nameLength + extra + comment > end) throw new Error('android_license_archive_entry')
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
    cursor += 46 + nameLength + extra + comment
    if (names.has(name)) throw new Error('android_license_duplicate_entry')
    names.add(name)
    const legal = legalName.test(name.split('/').at(-1)), nested = name.endsWith('.jar')
    if (name.endsWith('/') || (!legal && !nested)) continue
    if (name.includes('\\') || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.')
      || flags & 1 || ![0, 8].includes(method) || size > (nested ? MAX_ARCHIVE : MAX_TEXT)
      || local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('android_license_archive_member')
    const localNameLength = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28)
    const data = local + 30 + localNameLength + localExtra
    if (data + compressed > start || !bytes.subarray(local + 30, local + 30 + localNameLength).equals(Buffer.from(name))) throw new Error('android_license_archive_local')
    const packed = bytes.subarray(data, data + compressed)
    const plain = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: nested ? MAX_ARCHIVE : MAX_TEXT })
    if (plain.length !== size || crc32(plain) !== checksum) throw new Error('android_license_archive_checksum')
    if (nested) {
      if (++nestedArchives > 64) throw new Error('android_license_nested_limit')
      const children = archiveLicenseTexts(plain, `${prefix}${name}!/`, depth + 1)
      collectedBytes += children.reduce((total, child) => total + Buffer.byteLength(child.text), 0)
      files.push(...children)
    }
    else {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(plain)
      if (!text.trim() || text.includes('\0')) throw new Error('android_license_invalid_text')
      files.push({ file: prefix + name, sha256: hash(plain), text })
      collectedBytes += plain.length
    }
    if (collectedBytes > MAX_LEGAL_TOTAL) throw new Error('android_license_text_total')
  }
  if (cursor !== end) throw new Error('android_license_archive_directory')
  return files
}

/** Select only the exact native-enabled Gradle task response, never a cached dependency guess. */
export function parseReleaseClasspath(output) {
  const matches = output.split(/\r?\n/u).filter(line => line.startsWith('IROH_RELEASE_DEPENDENCIES='))
  if (matches.length !== 1) throw new Error('android_license_classpath_response')
  const result = JSON.parse(matches[0].slice('IROH_RELEASE_DEPENDENCIES='.length))
  if (result.schemaVersion !== 1 || result.configuration !== 'releaseRuntimeClasspath' || result.nativeEnabled !== true
    || !Array.isArray(result.artifacts) || result.artifacts.length === 0 || result.artifacts.length > 1000) throw new Error('android_license_classpath_invalid')
  const identities = new Set()
  for (const item of result.artifacts) {
    if (!['group', 'name', 'version'].every(key => typeof item[key] === 'string' && /^[A-Za-z0-9_.+-]+$/u.test(item[key]))
      || !['aar', 'jar'].includes(item.type) || typeof item.file !== 'string' || !isAbsolute(item.file)
      || item.classifier !== null && (typeof item.classifier !== 'string' || !/^[A-Za-z0-9_.+-]+$/u.test(item.classifier))) throw new Error('android_license_artifact_invalid')
    const identity = `${item.group}:${item.name}:${item.version}:${item.classifier ?? ''}:${item.type}`
    if (identities.has(identity)) throw new Error('android_license_artifact_duplicate')
    identities.add(identity)
  }
  return result.artifacts
}

/** Require every Android native dependency to have full texts in the prepared Rust notice inventory. */
export function validateNativeCoverage(inventory, selected, lockfileSha256) {
  if (inventory.schemaVersion !== 1 || inventory.lockfileSha256 !== lockfileSha256 || !Array.isArray(inventory.packages)) throw new Error('android_license_native_inventory_stale')
  for (const item of selected) {
    if (item.source === 'workspace') continue
    const matches = inventory.packages.filter(pkg => pkg.name === item.name && pkg.version === item.version && pkg.source === item.source)
    if (matches.length !== 1 || !Array.isArray(matches[0].licenses) || !matches[0].licenses.length
      || matches[0].licenses.some(file => !/^[a-f0-9]{64}$/u.test(file.sha256))) throw new Error(`android_license_native_missing:${item.name}@${item.version}`)
  }
}

async function regularBytes(path, limit) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('android_license_input_invalid')
  const bytes = await readFile(path)
  if (bytes.length > limit) throw new Error('android_license_input_size')
  return bytes
}

/** Build full APK notices; Maven coordinates are taken exclusively from the resolved release classpath. */
export async function androidReleaseNotices(root, artifacts, { nativeInventory, nativeText, selectedNative, lockfileSha256, fetchText = fetch, cacheDirectory } = {}) {
  validateNativeCoverage(nativeInventory, selectedNative, lockfileSha256)
  if (typeof nativeText !== 'string' || !nativeText.startsWith('THIRD-PARTY SOFTWARE NOTICES\n') || nativeText.length < 1000) throw new Error('android_license_native_text_invalid')
  const pins = JSON.parse(await readFile(join(root, 'scripts/android-release-license-sources.json'), 'utf8'))
  const fetched = new Map()
  const sections = ['DSH MOBILE IROH — ANDROID THIRD-PARTY NOTICES',
    'Original license, copyright and notice texts from the resolved releaseRuntimeClasspath artifacts and the prepared native dependency distribution are reproduced below.',
    'The native section conservatively also includes supported Host/build dependencies; a listed package is not necessarily linked into this APK.', '']
  for (const file of await packageLicenseFiles(root)) sections.push(`========== Project notice: ${file.file} ==========`, file.text.trimEnd(), '')
  const packages = []
  for (const artifact of artifacts) {
    const coordinate = `${artifact.group}:${artifact.name}:${artifact.version}`
    const bytes = await regularBytes(artifact.file, MAX_ARCHIVE)
    const licenses = archiveLicenseTexts(bytes)
    let source
    if (!licenses.length) {
      source = pins.sources?.[pins.packages?.[coordinate]]
      if (!source || !Array.isArray(source.files) || source.files.length === 0) throw new Error(`android_license_text_missing:${coordinate}`)
      for (const pin of source.files) {
        if (!/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[a-f0-9]{40}\//u.test(pin.url)
          && pin.url !== 'https://www.apache.org/licenses/LICENSE-2.0') throw new Error('android_license_source_invalid')
        const key = `${pin.url}:${pin.sha256}`
        if (!fetched.has(key)) {
          if (!/^[a-f0-9]{64}$/u.test(pin.sha256)) throw new Error('android_license_source_invalid')
          const cacheFile = cacheDirectory === undefined ? undefined : join(cacheDirectory, `${pin.sha256}.txt`)
          let downloaded = cacheFile === undefined ? undefined : await regularBytes(cacheFile, MAX_TEXT).catch(error => { if (error.code !== 'ENOENT') throw error })
          if (downloaded === undefined) {
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                const response = await fetchText(pin.url, { redirect: 'error', signal: AbortSignal.timeout(30_000) })
                if (!response.ok) throw new Error(`android_license_fetch_failed:${coordinate}`)
                downloaded = Buffer.from(await response.arrayBuffer()); break
              } catch (error) { if (attempt === 1) throw error }
            }
            const text = verifyLicenseSource(downloaded, pin)
            if (cacheFile !== undefined) await writeFile(cacheFile, downloaded, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error })
            fetched.set(key, text)
          } else fetched.set(key, verifyLicenseSource(downloaded, pin))
        }
        licenses.push({ file: pin.file, sourceUrl: pin.url, sha256: pin.sha256, text: fetched.get(key) })
      }
    }
    sections.push(`========== ${coordinate} ==========`, `Distributed artifact: ${basename(artifact.file)}`,
      ...(source?.basis ? [`Legal-text source: ${source.basis}`] : []))
    for (const license of licenses) sections.push(`--- ${license.file} ---`, ...(license.sourceUrl ? [`Source: ${license.sourceUrl}`] : []), license.text.trimEnd(), '')
    packages.push({ coordinate, type: artifact.type, classifier: artifact.classifier, artifactSha256: hash(bytes),
      ...(source?.basis ? { legalTextSource: source.basis } : {}), ...(source?.declarationUrl ? { declarationUrl: source.declarationUrl } : {}),
      licenses: licenses.map(({ text: _text, ...license }) => license) })
  }
  sections.push('========== Native Rust dependency notices ==========', nativeText.trimEnd(), '')
  const notice = sections.join('\n')
  const metadata = { schemaVersion: 1, configuration: 'releaseRuntimeClasspath', nativeEnabled: true, lockfileSha256,
    nativeTargets: ['aarch64-linux-android', 'x86_64-linux-android'],
    androidNativePackages: selectedNative.filter(item => item.source !== 'workspace').map(({ name, version, source }) => ({ name, version, source })),
    nativeNoticesSha256: hash(Buffer.from(nativeText)), noticeSha256: hash(Buffer.from(notice)), mavenPackages: packages }
  return { notice, metadata }
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), android = join(root, 'apps/mobile/android')
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--ndk' || !isAbsolute(args[1])) throw new Error('usage: node scripts/android-release-notices.mjs --ndk <absolute NDK directory>')
  const options = { cwd: android, encoding: 'utf8', windowsHide: true, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 }
  const gradleArgs = ['--no-daemon', '--console', 'plain', '-PirohNative=true', `-PirohNdk=${args[1]}`, '-I', join(root, 'scripts/android-release-dependencies.init.gradle'), ':app:irohReleaseLicenseDependencies']
  const launcher = process.platform === 'win32' ? 'cmd.exe' : join(android, 'gradlew')
  if (process.platform === 'win32' && [android, ...gradleArgs].some(value => /[\r\n"%!^&|<>]/u.test(value))) throw new Error('android_license_gradle_path_invalid')
  const command = process.platform === 'win32' ? ['/d', '/s', '/c', `""${join(android, 'gradlew.bat')}" ${gradleArgs.map(value => `"${value}"`).join(' ')}"`] : gradleArgs
  const { stdout } = await promisify(execFile)(launcher, command, { ...options, windowsVerbatimArguments: process.platform === 'win32' })
  const artifacts = parseReleaseClasspath(stdout), selected = new Map()
  const lockfile = await readFile(join(root, 'Cargo.lock')), lockfileSha256 = hash(lockfile)
  for (const target of ['aarch64-linux-android', 'x86_64-linux-android']) {
    const { stdout } = await promisify(execFile)('cargo', ['metadata', '--format-version', '1', '--locked', '--offline', '--filter-platform', target], { ...options, cwd: root, maxBuffer: 64 * 1024 * 1024 })
    for (const item of collectInventory(JSON.parse(stdout), ['dsh-mobile-iroh-android-transport'])) selected.set(`${item.name}@${item.version}`, item)
  }
  if (!lockfile.equals(await readFile(join(root, 'Cargo.lock')))) throw new Error('android_license_lockfile_changed')
  const cacheDirectory = join(root, 'artifacts/android-license-cache')
  await mkdir(cacheDirectory, { recursive: true })
  if ((await lstat(cacheDirectory)).isSymbolicLink()) throw new Error('android_license_cache_symlink')
  const generated = await androidReleaseNotices(root, artifacts, {
    nativeInventory: JSON.parse(await regularBytes(join(root, 'native/dependencies.json'), 4 * 1024 * 1024)),
    nativeText: (await regularBytes(join(root, 'native/THIRD_PARTY_NOTICES.txt'), 16 * 1024 * 1024)).toString('utf8'),
    selectedNative: [...selected.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en')), lockfileSha256, cacheDirectory,
  })
  const directory = join(android, 'app/src/main/assets')
  await mkdir(directory, { recursive: true })
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('android_license_output_symlink')
  for (const [name, text] of [['THIRD_PARTY_NOTICES.txt', generated.notice], ['third-party-dependencies.json', JSON.stringify(generated.metadata, null, 2) + '\n']]) {
    const path = join(directory, name), previous = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error })
    if (previous && (!previous.isFile() || previous.isSymbolicLink())) throw new Error('android_license_output_invalid')
    await writeFile(path, text)
  }
  console.log(JSON.stringify({ mavenPackages: artifacts.length, androidNativePackages: generated.metadata.androidNativePackages.length, noticeSha256: generated.metadata.noticeSha256 }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
