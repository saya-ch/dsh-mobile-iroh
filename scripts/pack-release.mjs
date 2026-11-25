import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, copyFile, lstat, mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { NATIVE_TARGETS } from '../src/native-artifact.mjs'
import { checkRelease, validatePackedFiles } from './check-release.mjs'
import * as tar from 'tar'

const MH_MAGIC_64 = 0xfeedfacf
const MH_EXECUTE = 0x2
const LC_CODE_SIGNATURE = 0x1d
const CPU_TYPE_X86_64 = 0x01000007
const CPU_TYPE_ARM64 = 0x0100000c

/** Validate actual executable architecture, not an extension or caller-provided label. */
export function verifyBinaryHeader(bytes, target) {
  if (target === 'linux-x64') {
    if (bytes.length < 64 || bytes.subarray(0, 4).toString('hex') !== '7f454c46' || bytes[4] !== 2
      || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 62) throw new Error('iroh_release_binary_target_mismatch')
  } else if (target === 'win32-x64') {
    const offset = bytes.length >= 64 ? bytes.readUInt32LE(60) : 0
    if (bytes.subarray(0, 2).toString() !== 'MZ' || offset < 64 || offset + 24 > bytes.length
      || bytes.subarray(offset, offset + 4).toString('hex') !== '50450000'
      || bytes.readUInt16LE(offset + 4) !== 0x8664) throw new Error('iroh_release_binary_target_mismatch')
  } else if (target === 'darwin-x64' || target === 'darwin-arm64') {
    // Thin little-endian MH_MAGIC_64 executable for exactly one Apple CPU, plus Apple's own
    // arm64 rule: the kernel refuses to start an arm64 Mach-O without a code signature, and a
    // macOS linker always emits at least an ad-hoc one. A cross-linked stub from a non-Mac host
    // fails both checks, so it can never be staged as a darwin artifact.
    if (bytes.length < 32 || bytes.readUInt32LE(0) !== MH_MAGIC_64 || bytes.readUInt32LE(12) !== MH_EXECUTE
      || bytes.readUInt32LE(4) !== (target === 'darwin-arm64' ? CPU_TYPE_ARM64 : CPU_TYPE_X86_64)) {
      throw new Error('iroh_release_binary_target_mismatch')
    }
    let offset = 32, signature = false
    for (let index = 0, count = bytes.readUInt32LE(16); index < count; index += 1) {
      if (offset + 8 > bytes.length) throw new Error('iroh_release_binary_target_mismatch')
      const command = bytes.readUInt32LE(offset), size = bytes.readUInt32LE(offset + 4)
      if (size < 8 || offset + size > bytes.length) throw new Error('iroh_release_binary_target_mismatch')
      if (command === LC_CODE_SIGNATURE) signature = true
      offset += size
    }
    if (target === 'darwin-arm64' && !signature) throw new Error('iroh_release_binary_unsigned')
  } else throw new Error('iroh_release_binary_target_unsupported')
}

const PACK_FLAGS = Object.freeze([
  ['--windows', 'win32-x64', 'windows', 'EXE'],
  ['--linux', 'linux-x64', 'linux', 'ELF'],
  ['--darwin-x64', 'darwin-x64', 'darwinX64', 'Mach-O x86_64'],
  ['--darwin-arm64', 'darwin-arm64', 'darwinArm64', 'Mach-O arm64'],
  ['--output', 'output', 'output', 'directory'],
])

export function parsePackArguments(args) {
  if (args.length !== PACK_FLAGS.length * 2 || PACK_FLAGS.some(([flag], index) => args[index * 2] !== flag
    || !isAbsolute(args[index * 2 + 1] ?? '') || args[index * 2 + 1].includes('\0'))) {
    throw new Error(`Expected ${PACK_FLAGS.map(([flag, , , kind]) => `${flag} <absolute ${kind}>`).join(' ')}`)
  }
  return Object.fromEntries(PACK_FLAGS.map(([, , key], index) => [key, args[index * 2 + 1]]))
}

/** Use node-tar's supported entry hook to preserve Unix execution bits on Windows packing hosts. */
export async function createReleaseArchive(root, file, paths) {
  const expected = new Map()
  for (const path of paths) expected.set(path, createHash('sha256').update(await readFile(join(root, path))).digest('hex'))
  const native = new Set(Object.values(NATIVE_TARGETS).map(name => `native/${name}`))
  await pipeline(tar.c({ cwd: root, gzip: true, portable: true, noMtime: true, prefix: 'package/', strict: true,
    onWriteEntry(entry) {
      if (entry.type !== 'File' || !expected.has(entry.path)) throw new Error('iroh_release_archive_entry_invalid')
      entry.stat.mode = native.has(entry.path) ? 0o755 : 0o644
    },
  }, paths), createWriteStream(file, { flags: 'wx', mode: 0o644 }))
  const entries = [], observed = new Map()
  await tar.t({ file, strict: true, onReadEntry(entry) {
    if (entry.type !== 'File' || !entry.path.startsWith('package/')) throw new Error('iroh_release_archive_entry_invalid')
    const path = entry.path.slice('package/'.length)
    if (!expected.has(path) || observed.has(path)) throw new Error('iroh_release_archive_entry_invalid')
    observed.set(path, undefined)
    entries.push({ path, size: entry.size, mode: entry.mode })
    const hash = createHash('sha256')
    entry.on('data', chunk => hash.update(chunk))
    entry.once('end', () => observed.set(path, hash.digest('hex')))
  } })
  if (observed.size !== expected.size || [...expected].some(([path, hash]) => observed.get(path) !== hash)) throw new Error('iroh_release_archive_content_mismatch')
  return entries
}

/**
 * Stage known binaries, inspect the whitelist, and pack one immutable npm tarball.
 * Packing is the only step that writes `native/manifest.json`, and it writes a complete
 * inventory: a declared-pending target cannot survive into a release candidate.
 */
export async function packRelease(root, options) {
  const { output } = options
  const native = join(root, 'native')
  await mkdir(native, { recursive: true })
  if ((await lstat(native)).isSymbolicLink()) throw new Error('iroh_release_native_symlink')
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const npmCli = process.env.npm_execpath && basename(process.env.npm_execpath) === 'npm-cli.js'
    ? process.env.npm_execpath : join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
  const execute = promisify(execFile)
  await execute(process.execPath, [npmCli, 'run', 'build:client'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  const manifest = { schemaVersion: 1, packageVersion: pkg.version, artifacts: {} }
  for (const [, target, key] of PACK_FLAGS.slice(0, -1)) {
    const source = options[key]
    const metadata = await lstat(source)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 64 || metadata.size > 128 * 1024 * 1024) throw new Error('iroh_release_binary_invalid')
    const bytes = await readFile(source)
    verifyBinaryHeader(bytes, target)
    const file = NATIVE_TARGETS[target], destination = join(native, file)
    const previous = await lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error })
    if (previous?.isSymbolicLink() || previous && !previous.isFile()) throw new Error('iroh_release_binary_destination_invalid')
    if (resolve(source) !== resolve(destination)) await copyFile(source, destination)
    await chmod(destination, 0o755)
    manifest.artifacts[target] = { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }
  const previousManifest = await lstat(join(native, 'manifest.json')).catch(error => { if (error.code !== 'ENOENT') throw error })
  if (previousManifest?.isSymbolicLink() || previousManifest && !previousManifest.isFile()) throw new Error('iroh_release_manifest_destination_invalid')
  const manifestFile = await open(join(native, 'manifest.json'), 'w', 0o644)
  try { await manifestFile.writeFile(JSON.stringify(manifest, null, 2) + '\n') } finally { await manifestFile.close() }
  await checkRelease(root)
  const runNpm = async args => JSON.parse((await execute(process.execPath, [npmCli, ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 120_000,
  })).stdout)
  const [preview] = await runNpm(['pack', '--dry-run', '--ignore-scripts', '--json'])
  validatePackedFiles(preview.files.map(item => item.path), pkg)
  await mkdir(output, { recursive: true })
  const expectedName = `${pkg.name}-${pkg.version}.tgz`
  const existing = await lstat(join(output, expectedName)).catch(error => { if (error.code !== 'ENOENT') throw error })
  if (existing) throw new Error('iroh_release_tarball_already_exists')
  const tarball = join(output, expectedName)
  const entries = await createReleaseArchive(root, tarball, preview.files.map(item => item.path).sort())
  validatePackedFiles(entries, pkg)
  const packedBytes = await readFile(tarball)
  const sha256 = createHash('sha256').update(packedBytes).digest('hex')
  await writeFile(tarball + '.sha256', `${sha256}  ${expectedName}\n`, { flag: 'wx' })
  await copyFile(join(native, 'THIRD_PARTY_NOTICES.txt'), join(output, 'THIRD_PARTY_NOTICES.txt'))
  await copyFile(join(native, 'dependencies.json'), join(output, 'dependencies.json'))
  return { tarball, sha256, integrity: 'sha512-' + createHash('sha512').update(packedBytes).digest('base64'), files: entries.length, packageVersion: pkg.version, channel: 'alpha' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await packRelease(resolve(dirname(fileURLToPath(import.meta.url)), '..'), parsePackArguments(process.argv.slice(2)))))
}
