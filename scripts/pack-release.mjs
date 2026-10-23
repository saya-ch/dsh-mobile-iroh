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
  } else throw new Error('iroh_release_binary_target_unsupported')
}

export function parsePackArguments(args) {
  if (args.length !== 6 || args[0] !== '--windows' || args[2] !== '--linux' || args[4] !== '--output'
    || [args[1], args[3], args[5]].some(value => !isAbsolute(value) || value.includes('\0'))) {
    throw new Error('Expected --windows <absolute EXE> --linux <absolute ELF> --output <absolute directory>')
  }
  return { windows: args[1], linux: args[3], output: args[5] }
}

/** Use node-tar's supported entry hook to preserve Unix execution bits on Windows packing hosts. */
export async function createReleaseArchive(root, file, paths) {
  const expected = new Map()
  for (const path of paths) expected.set(path, createHash('sha256').update(await readFile(join(root, path))).digest('hex'))
  await pipeline(tar.c({ cwd: root, gzip: true, portable: true, noMtime: true, prefix: 'package/', strict: true,
    onWriteEntry(entry) {
      if (entry.type !== 'File' || !expected.has(entry.path)) throw new Error('iroh_release_archive_entry_invalid')
      entry.stat.mode = entry.path === `native/${NATIVE_TARGETS['linux-x64']}` || entry.path === `native/${NATIVE_TARGETS['win32-x64']}` ? 0o755 : 0o644
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

/** Stage known binaries, inspect the whitelist, and pack one immutable npm tarball. */
export async function packRelease(root, { windows, linux, output }) {
  const native = join(root, 'native')
  await mkdir(native, { recursive: true })
  if ((await lstat(native)).isSymbolicLink()) throw new Error('iroh_release_native_symlink')
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const npmCli = process.env.npm_execpath && basename(process.env.npm_execpath) === 'npm-cli.js'
    ? process.env.npm_execpath : join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
  const execute = promisify(execFile)
  await execute(process.execPath, [npmCli, 'run', 'build:client'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  const manifest = { schemaVersion: 1, packageVersion: pkg.version, artifacts: {} }
  for (const [target, source] of [['win32-x64', windows], ['linux-x64', linux]]) {
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
