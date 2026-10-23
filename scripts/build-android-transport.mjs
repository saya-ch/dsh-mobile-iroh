import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LIBRARY = 'libdsh_mobile_iroh_android_transport.so'
const SYMBOL_PREFIX = 'Java_io_github_sayach_dshmobileiroh_IrohNative_'

/** Explicit supported ABI/compiler pairs; API 29 matches this app's minimum SDK. */
export const ABI_TARGETS = Object.freeze({
  'arm64-v8a': { rust: 'aarch64-linux-android', clang: 'aarch64-linux-android29', machine: 183 },
  'x86_64': { rust: 'x86_64-linux-android', clang: 'x86_64-linux-android29', machine: 62 },
})

/** Validate native LOAD/RELRO segments without relying on localized tool output. */
export function inspectElf(bytes, expectedMachine) {
  if (bytes.length < 64 || !bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))
    || bytes[4] !== 2 || bytes[5] !== 1) throw new Error('expected a little-endian ELF64 shared library')
  if (bytes.readUInt16LE(16) !== 3 || bytes.readUInt16LE(18) !== expectedMachine) {
    throw new Error('native library type or architecture differs from its APK ABI')
  }
  const offset = Number(bytes.readBigUInt64LE(32))
  const entrySize = bytes.readUInt16LE(54)
  const count = bytes.readUInt16LE(56)
  if (!Number.isSafeInteger(offset) || entrySize < 56 || count === 0
    || offset + entrySize * count > bytes.length) throw new Error('invalid ELF program headers')
  const loads = []
  for (let index = 0; index < count; index += 1) {
    const at = offset + index * entrySize
    const type = bytes.readUInt32LE(at)
    if (type === 1) {
      const alignment = bytes.readBigUInt64LE(at + 48)
      if (alignment < 16_384n) throw new Error('ELF LOAD is not 16 KB aligned')
      loads.push(alignment.toString())
    }
    if (type === 0x6474e552) {
      const end = bytes.readBigUInt64LE(at + 16) + bytes.readBigUInt64LE(at + 40)
      if (end % 16_384n !== 0n) throw new Error('ELF RELRO end is not 16 KB aligned')
    }
  }
  if (loads.length === 0) throw new Error('ELF has no LOAD segments')
  return { machine: expectedMachine, loadAlignments: loads }
}

/** Validate the command line before any Cargo command or output mutation. */
export function parseOptions(args) {
  const options = { abis: ['arm64-v8a', 'x86_64'], output: join(ROOT, 'artifacts/android/jniLibs') }
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    const value = args[++index]
    if (!['--ndk', '--abis', '--output', '--verify-apk', '--build-tools'].includes(flag) || !value) {
      throw new Error(`invalid Android transport argument: ${flag}`)
    }
    if (flag === '--abis') options.abis = value.split(',')
    else if (flag === '--output') options.output = resolve(value)
    else if (flag === '--ndk') options.ndk = resolve(value)
    else if (flag === '--build-tools') options.buildTools = resolve(value)
    else options.apk = resolve(value)
  }
  if (options.abis.length === 0 || new Set(options.abis).size !== options.abis.length
    || options.abis.some(abi => !Object.hasOwn(ABI_TARGETS, abi))) throw new Error('unsupported or duplicate ABI')
  return options
}

/** A passing zip alignment check alone is insufficient for a native-enabled APK. */
export function verifyApkEntries(entries, abis) {
  for (const abi of abis) {
    const expected = `lib/${abi}/${LIBRARY}`
    if (entries.filter(entry => entry === expected).length !== 1) throw new Error(`APK must contain exactly one ${abi} transport library`)
  }
  const unexpected = entries.filter(entry => entry.startsWith('lib/') && entry.endsWith(`/${LIBRARY}`)
    && !abis.some(abi => entry === `lib/${abi}/${LIBRARY}`))
  if (unexpected.length) throw new Error('APK contains an unselected transport ABI')
}

function run(command, args, env = process.env, capture = false) {
  const result = spawnSync(command, args, { cwd: ROOT, env, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${capture ? result.stderr : ''}`)
  return result.stdout ?? ''
}

async function resolveNdk(options) {
  if (options.ndk) return options.ndk
  const configured = process.env.ANDROID_NDK_HOME || process.env.ANDROID_NDK_ROOT
  if (configured) return resolve(configured)
  throw new Error('pass --ndk or set ANDROID_NDK_HOME to an explicitly selected NDK version')
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  if (options.apk) {
    if (!options.buildTools) throw new Error('--verify-apk requires an explicit --build-tools directory')
    // Android builds already require a JDK; its archive reader avoids an owned ZIP parser.
    const entries = run('jar', ['tf', options.apk], process.env, true).split(/\r?\n/u).filter(Boolean)
    verifyApkEntries(entries, options.abis)
    const executable = join(options.buildTools, process.platform === 'win32' ? 'zipalign.exe' : 'zipalign')
    run(executable, ['-c', '-P', '16', '-v', '4', options.apk])
    return
  }
  const ndk = await resolveNdk(options)
  const sourceProperties = await readFile(join(ndk, 'source.properties'), 'utf8')
  const revision = /^Pkg\.Revision\s*=\s*(.+)$/mu.exec(sourceProperties)?.[1]?.trim()
  if (!revision) throw new Error('selected NDK has no package revision')
  const host = process.platform === 'win32' ? 'windows-x86_64'
    : process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64'
  const bin = join(ndk, 'toolchains/llvm/prebuilt', host, 'bin')
  const exe = process.platform === 'win32' ? '.exe' : ''
  const clang = join(bin, `clang${exe}`)
  const ar = join(bin, `llvm-ar${exe}`)
  const nm = join(bin, `llvm-nm${exe}`)
  const strip = join(bin, `llvm-strip${exe}`)
  const targetDirectory = resolve(process.env.CARGO_TARGET_DIR || join(ROOT, 'target'))
  if (!isAbsolute(targetDirectory)) throw new Error('Cargo target directory must be absolute')
  const evidence = { ndk: revision, profile: 'release', api: 29, libraries: {} }
  for (const abi of options.abis) {
    const spec = ABI_TARGETS[abi]
    const key = spec.rust.replaceAll('-', '_')
    const env = {
      ...process.env,
      CARGO_TARGET_DIR: targetDirectory,
      [`CARGO_TARGET_${key.toUpperCase()}_LINKER`]: clang,
      [`CARGO_TARGET_${key.toUpperCase()}_RUSTFLAGS`]:
        `-C link-arg=--target=${spec.clang} -C link-arg=-Wl,-z,max-page-size=16384 -C link-arg=-Wl,-z,common-page-size=16384`,
      [`CC_${key}`]: clang,
      [`CXX_${key}`]: join(bin, `clang++${exe}`),
      [`AR_${key}`]: ar,
      [`CFLAGS_${key}`]: `--target=${spec.clang}`,
      [`CXXFLAGS_${key}`]: `--target=${spec.clang}`,
    }
    run('cargo', ['build', '--locked', '--release', '--package', 'dsh-mobile-iroh-android-transport', '--target', spec.rust], env)
    const library = join(targetDirectory, spec.rust, 'release', LIBRARY)
    const output = join(options.output, abi)
    await mkdir(output, { recursive: true })
    const packagedLibrary = join(output, LIBRARY)
    await copyFile(library, packagedLibrary)
    run(strip, ['--strip-unneeded', packagedLibrary], env)
    const bytes = await readFile(packagedLibrary)
    const elf = inspectElf(bytes, spec.machine)
    const symbols = run(nm, ['--dynamic', '--defined-only', packagedLibrary], env, true)
    for (const name of ['nativeInitialize', 'nativeConnect', 'nativeClose', 'nativeStatus']) {
      if (!symbols.includes(`${SYMBOL_PREFIX}${name}`)) throw new Error(`missing JNI export: ${name}`)
    }
    evidence.libraries[abi] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...elf }
  }
  const unexpected = (await readdir(options.output, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && !options.abis.includes(entry.name))
  if (unexpected.length) throw new Error(`stale unselected ABI output: ${unexpected.map(entry => entry.name).join(', ')}`)
  await writeFile(join(options.output, 'verification.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
