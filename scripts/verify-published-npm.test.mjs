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

test('the explicit first-publication exception accepts only the documented bootstrap namespace', () => {
  const bytes = Buffer.from('first packed candidate'), version = '0.1.0-alpha.1'
  const url = `https://registry.npmjs.org/dsh-mobile-iroh/-/dsh-mobile-iroh-${version}.tgz`
  const metadata = { name: 'dsh-mobile-iroh', maintainers: [{ name: 'saya-ch' }],
    'dist-tags': { alpha: version, latest: version }, versions: {
      '0.0.0-stage': { name: 'dsh-mobile-iroh', version: '0.0.0-stage' },
      [version]: { name: 'dsh-mobile-iroh', version, publishConfig: { tag: 'alpha' }, dist: {
        integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'), tarball: url,
      } },
    } }
  const options = { allowInitialLatest: true }
  assert.throws(() => verifyPublishedMetadata(metadata, version, bytes), /artifact_mismatch/)
  assert.equal(verifyPublishedMetadata(metadata, version, bytes, options), url)
  for (const mutate of [m => { m.versions['0.1.0'] = {} }, m => { m.versions['0.1.0-alpha.2'] = {} },
    m => { m['dist-tags'].beta = version }, m => { m['dist-tags'].alpha = '0.0.0-stage' },
    m => { m.maintainers[0].name = 'someone-else' }, m => { m.maintainers.push({ name: 'another' }) },
    m => { m.versions[version].publishConfig.tag = 'latest' },
    m => { m.versions[version].dist.integrity = 'changed' },
    m => { m.versions[version].dist.tarball = 'https://untrusted.invalid/a.tgz' }]) {
    const changed = structuredClone(metadata); mutate(changed)
    assert.throws(() => verifyPublishedMetadata(changed, version, bytes, options), /mismatch|url_invalid/)
  }
  assert.throws(() => verifyPublishedMetadata(metadata, '0.2.0-alpha.1', bytes, options), /artifact_mismatch/)
  const laterVersion = '0.1.0-alpha.2'
  const later = structuredClone(metadata)
  later.versions = { [laterVersion]: { ...later.versions[version], version: laterVersion,
    dist: { ...later.versions[version].dist, tarball: url.replace(version, laterVersion) } } }
  later['dist-tags'] = { alpha: laterVersion, latest: laterVersion }
  assert.throws(() => verifyPublishedMetadata(later, laterVersion, bytes, options), /artifact_mismatch/)
})
