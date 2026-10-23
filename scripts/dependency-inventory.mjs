/** Produce a conservative Cargo source-license inventory, not a binary SBOM or legal approval. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const roots = ['dsh-mobile-iroh-host', 'dsh-mobile-iroh-android-transport']

/** Include every resolved dependency edge, including target/build-only edges; omit local filesystem paths. */
export function collectInventory(metadata, selectedRoots = roots) {
  const packages = new Map(metadata.packages.map(item => [item.id, item]))
  const edges = new Map(metadata.resolve.nodes.map(item => [item.id, item.dependencies]))
  const selected = selectedRoots.map(name => {
    const matches = metadata.packages.filter(item => item.name === name && item.source === null)
    if (matches.length !== 1) throw new Error('inventory_root_not_unique')
    return matches[0].id
  })
  const seen = new Set()
  const pending = [...selected]
  while (pending.length) {
    const id = pending.pop()
    if (seen.has(id)) continue
    if (!packages.has(id) || !edges.has(id)) throw new Error('inventory_incomplete_dependency_graph')
    seen.add(id)
    pending.push(...edges.get(id))
  }
  return [...seen].map(id => {
    const item = packages.get(id)
    return {
      name: item.name, version: item.version, source: item.source ?? 'workspace',
      licenseExpression: item.license ?? null, declaredLicenseFile: item.license_file !== null && item.license_file !== undefined,
      repository: item.repository ?? null,
    }
  }).sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'))
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const output = join(root, 'artifacts', 'security', 'cargo-license-inventory.json')
  const lockfile = await readFile(join(root, 'Cargo.lock'))
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--locked', '--offline'], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
  }))
  const inventory = collectInventory(metadata)
  const licenseFiles = []
  const selected = new Set(inventory.map(item => `${item.name}@${item.version}`))
  for (const item of metadata.packages) {
    if (!selected.has(`${item.name}@${item.version}`) || !item.license_file) continue
    const bytes = await readFile(resolve(dirname(item.manifest_path), item.license_file))
    if (bytes.length > 1_048_576) throw new Error('inventory_license_file_too_large')
    licenseFiles.push({ name: item.name, version: item.version, sha256: hash(bytes), text: bytes.toString('utf8') })
  }
  if (!lockfile.equals(await readFile(join(root, 'Cargo.lock')))) throw new Error('inventory_lockfile_changed')
  const missingLicenseDeclarations = inventory.filter(item => item.source !== 'workspace' && !item.licenseExpression && !item.declaredLicenseFile)
  const report = {
    generatedAt: new Date().toISOString(), lockfileSha256: hash(lockfile), roots,
    method: 'cargo metadata --format-version 1 --locked --offline; all resolved dependency edges',
    scope: 'Conservative source dependency superset, including build/target-only packages. Not a final host/APK binary SBOM, license-expression interpretation or distribution approval.',
    packages: inventory, declaredLicenseFiles: licenseFiles,
    missingLicenseDeclarations,
    remaining: ['Review obligations for each shipped artifact and include required full third-party notices before distribution.', 'Android Maven dependencies and externally installed Node modules require separate inventories; they are not represented here.'],
  }
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ output, packages: inventory.length, missingLicenseDeclarations: missingLicenseDeclarations.length, lockfileSha256: report.lockfileSha256 }))
  if (missingLicenseDeclarations.length) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
