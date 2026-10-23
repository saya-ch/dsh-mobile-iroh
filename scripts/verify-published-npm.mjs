import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Match the public registry artifact to the already tested tarball, not only its displayed version. */
export function verifyPublishedMetadata(metadata, version, bytes, { allowInitialLatest = false } = {}) {
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64')
  const published = metadata?.versions?.[version]
  // npm's first-publication latest alias is recorded explicitly, not silently treated as alpha-only.
  const initialLatest = allowInitialLatest === true && version === '0.1.0-alpha.1'
    && published?.publishConfig?.tag === 'alpha'
    && metadata?.['dist-tags']?.alpha === version && metadata?.['dist-tags']?.latest === version
    && Object.keys(metadata['dist-tags']).every(tag => tag === 'alpha' || tag === 'latest')
    && Object.keys(metadata?.versions ?? {}).every(value => value === version || value === '0.0.0-stage')
    && metadata?.maintainers?.length === 1 && metadata.maintainers[0].name === 'saya-ch'
  if (metadata?.name !== 'dsh-mobile-iroh' || !published || published.name !== metadata.name || published.version !== version
    || published.dist?.integrity !== integrity || metadata['dist-tags']?.alpha !== version
    || metadata['dist-tags']?.latest === version && !initialLatest) {
    throw new Error('iroh_public_npm_artifact_mismatch')
  }
  const tarball = new URL(published.dist.tarball)
  if (tarball.origin !== 'https://registry.npmjs.org' || tarball.pathname !== `/dsh-mobile-iroh/-/dsh-mobile-iroh-${version}.tgz`
    || tarball.search || tarball.hash || tarball.username || tarball.password) throw new Error('iroh_public_npm_url_invalid')
  return tarball.href
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [file, version, option, extra] = process.argv.slice(2)
  if (!isAbsolute(file ?? '') || !/^0\.\d+\.\d+-alpha\.[1-9]\d*$/u.test(version ?? '') || extra !== undefined
    || option !== undefined && option !== '--allow-initial-latest') {
    throw new Error('Pass the absolute tested tarball, exact alpha version and optional --allow-initial-latest')
  }
  const local = await readFile(file)
  const response = await fetch('https://registry.npmjs.org/dsh-mobile-iroh', { redirect: 'error', signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error('iroh_public_npm_metadata_unavailable')
  const metadata = await response.json()
  const url = verifyPublishedMetadata(metadata, version, local, { allowInitialLatest: option === '--allow-initial-latest' })
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
  console.log(JSON.stringify({ package: 'dsh-mobile-iroh', version, tag: 'alpha', sha256,
    initialLatestAlias: metadata['dist-tags'].latest === version, publicTags: metadata['dist-tags'], publishedTarballVerified: true }))
}
