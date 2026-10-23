import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { verifyPublishedMetadata } from './verify-published-npm.mjs'

test('public npm verification rejects another artifact, channel or registry URL', () => {
  const bytes = Buffer.from('packed candidate'), version = '0.1.0-alpha.1'
  const url = `https://registry.npmjs.org/dsh-mobile-iroh/-/dsh-mobile-iroh-${version}.tgz`
  const metadata = { name: 'dsh-mobile-iroh', 'dist-tags': { alpha: version }, versions: {
    [version]: { name: 'dsh-mobile-iroh', version, dist: { integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'), tarball: url } },
  } }
  assert.equal(verifyPublishedMetadata(metadata, version, bytes), url)
  assert.throws(() => verifyPublishedMetadata(metadata, version, Buffer.from('different')), /artifact_mismatch/)
  for (const mutate of [m => { m['dist-tags'].latest = version }, m => { m['dist-tags'].alpha = '0.1.0-alpha.2' },
    m => { m.versions[version].dist.tarball = 'https://untrusted.invalid/a.tgz' }]) {
    const changed = structuredClone(metadata); mutate(changed)
    assert.throws(() => verifyPublishedMetadata(changed, version, bytes), /mismatch|url_invalid/)
  }
})
