import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Match the public registry artifact to the already tested tarball, not only its displayed version. */
export function verifyPublishedMetadata(metadata, version, bytes) {
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64')
  const published = metadata?.versions?.[version]
  if (metadata?.name !== 'dsh-mobile-iroh' || !published || published.name !== metadata.name || published.version !== version
    || published.dist?.integrity !== integrity || metadata['dist-tags']?.alpha !== version || metadata['dist-tags']?.latest === version) {
    throw new Error('iroh_public_npm_artifact_mismatch')
  }
  const tarball = new URL(published.dist.tarball)
  if (tarball.origin !== 'https://registry.npmjs.org' || tarball.pathname !== `/dsh-mobile-iroh/-/dsh-mobile-iroh-${version}.tgz`
    || tarball.search || tarball.hash || tarball.username || tarball.password) throw new Error('iroh_public_npm_url_invalid')
  return tarball.href
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [file, version, extra] = process.argv.slice(2)
  if (!isAbsolute(file ?? '') || !/^0\.\d+\.\d+-alpha\.[1-9]\d*$/u.test(version ?? '') || extra !== undefined) {
    throw new Error('Pass the absolute tested tarball and exact alpha version')
  }
  const local = await readFile(file)
  const response = await fetch('https://registry.npmjs.org/dsh-mobile-iroh', { redirect: 'error', signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error('iroh_public_npm_metadata_unavailable')
  const url = verifyPublishedMetadata(await response.json(), version, local)
  const artifact = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) })
  if (!artifact.ok) throw new Error('iroh_public_npm_tarball_unavailable')
  const hash = createHash('sha256'); let bytes = 0
  for await (const chunk of artifact.body) {
    bytes += chunk.length
    if (bytes > local.length) throw new Error('iroh_public_npm_tarball_size')
    hash.update(chunk)
  }
  const sha256 = createHash('sha256').update(local).digest('hex')
  if (bytes !== local.length || hash.digest('hex') !== sha256) throw new Error('iroh_public_npm_tarball_mismatch')
  console.log(JSON.stringify({ package: 'dsh-mobile-iroh', version, tag: 'alpha', sha256, publishedTarballVerified: true }))
}
