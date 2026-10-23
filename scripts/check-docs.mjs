/** Check repository-owned relative Markdown links without crawling external sites. */
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ignored = new Set(['.git', 'target', 'node_modules', 'artifacts', '.gradle', 'build'])
const files = []
async function scan(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(item.name)) continue
    const file = resolve(directory, item.name)
    if (item.isSymbolicLink()) continue
    if (item.isDirectory()) await scan(file)
    else if (item.isFile() && item.name.endsWith('.md')) files.push(file)
  }
}
await scan(root)
const errors = []
for (const file of files) {
  const source = (await readFile(file, 'utf8')).replace(/```[^\n]*\n[\s\S]*?```/gu, '')
  for (const match of source.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/gu)) {
    const link = match[1]
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/iu.test(link)) continue
    let target
    try { target = decodeURIComponent(link.replace(/[?#][\s\S]*$/u, '')) } catch { errors.push(`${file}: invalid link encoding`); continue }
    if (target === '') continue
    try { await stat(resolve(dirname(file), target)) } catch { errors.push(`${file}: missing ${target}`) }
  }
}
if (errors.length) throw new AggregateError(errors.map(error => new Error(error)), 'relative documentation links failed')
console.log(`Relative documentation links passed: ${files.length} Markdown files (external URLs and anchors are not verified)`)
