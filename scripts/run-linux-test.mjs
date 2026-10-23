/** Optional Windows cross-test runner; executes workspace-built x86_64 ELF files in existing WSL. */
import { spawnSync } from 'node:child_process'
import { open, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const targetRoot = join(root, 'target', 'x86_64-unknown-linux-musl')
const binary = resolve(process.argv[2] ?? '')
const inside = relative(targetRoot, binary)
if (!isAbsolute(binary) || inside.startsWith('..') || isAbsolute(inside) || process.platform !== 'win32') {
  throw new Error('Linux runner accepts only this workspace Windows cross-build target')
}
const file = await open(binary, 'r')
try {
  const header = Buffer.alloc(20)
  await file.read(header, 0, header.length, 0)
  if (!header.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) || header[4] !== 2 || header.readUInt16LE(18) !== 62) {
    throw new Error('Linux runner requires a verified x86_64 ELF executable')
  }
} finally { await file.close() }
const linuxPath = value => `/mnt/host/${value[0].toLowerCase()}${value.slice(2).replaceAll('\\', '/')}`
const host = join(targetRoot, 'debug', 'dsh-mobile-iroh-host')
const environment = []
try { if ((await stat(host)).isFile()) environment.push(`DSH_IROH_TEST_HOST_BINARY=${linuxPath(host)}`) } catch { /* Core-only tests need no host executable. */ }
const result = spawnSync('wsl.exe', ['-d', 'docker-desktop', '--exec', 'timeout', '-k', '5', '110', 'env', ...environment, linuxPath(binary), ...process.argv.slice(3)], {
  stdio: 'inherit', windowsHide: true, timeout: 130000,
})
if (result.error) throw result.error
if (result.signal) throw new Error(`Linux test launcher terminated by ${result.signal}`)
process.exitCode = result.status ?? 1
