/** Run an explicit cargo-audit binary against an explicit, already fetched RustSec snapshot. */
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [tool, database] = process.argv.slice(2)
if (process.argv.length !== 4 || !isAbsolute(tool ?? '') || !isAbsolute(database ?? '')) throw new Error('usage: node scripts/audit-dependencies.mjs ABS_CARGO_AUDIT ABS_RUSTSEC_DB')
for (const file of [join(root, '.cargo', 'audit.toml'), join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'audit.toml')]) {
  try { await access(file) }
  catch (error) { if (error.code === 'ENOENT') continue; throw error }
  throw new Error('inspect_audit_configuration_before_unfiltered_scan')
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const lockfile = join(root, 'Cargo.lock'), lockBytes = await readFile(lockfile)
const git = args => execFileSync('git', ['-C', database, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim()
if (git(['remote', 'get-url', 'origin']).replace(/\/$/u, '') !== 'https://github.com/RustSec/advisory-db.git') throw new Error('official_rustsec_remote_required')
if (git(['status', '--porcelain']) !== '') throw new Error('rustsec_snapshot_must_be_clean')
const commit = git(['rev-parse', 'HEAD'])
const output = join(root, 'artifacts', 'security', `${new Date().toISOString().replace(/[:.]/gu, '-')}-${commit.slice(0, 12)}`)
await mkdir(output, { recursive: false })
const args = ['audit', '--json', '--file', lockfile, '--db', database, '--no-fetch', '--url', 'https://github.com/RustSec/advisory-db.git', '--deny', 'warnings']
const result = spawnSync(tool, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })
await writeFile(join(output, 'stdout.json'), result.stdout ?? '')
await writeFile(join(output, 'stderr.txt'), result.stderr ?? '')
let audit
try { audit = JSON.parse(result.stdout) } catch { /* Raw tool failures remain in the receipt. */ }
const report = {
  generatedAt: new Date().toISOString(), command: [tool, ...args], exitCode: result.status, signal: result.signal,
  executionError: result.error?.message ?? null, toolSha256: hash(await readFile(tool)),
  toolVersion: execFileSync(tool, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim(),
  databaseCommit: commit, databaseTime: git(['show', '-s', '--format=%cI', 'HEAD']),
  lockfileSha256: hash(lockBytes), lockfileUnchanged: lockBytes.equals(await readFile(lockfile)),
  ignoredAdvisories: [], targetFilters: [], audit: audit ?? null,
  limits: ['RustSec matches against this exact snapshot and lockfile only.', 'Not source exploitability analysis, a license inventory or Android/Node audit.'],
}
await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ output, exitCode: result.status, databaseCommit: commit, lockfileUnchanged: report.lockfileUnchanged, vulnerabilities: audit?.vulnerabilities, warnings: audit?.warnings }))
process.exitCode = report.lockfileUnchanged && result.error === undefined ? result.status ?? 2 : 2
