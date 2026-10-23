import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync, crc32 } from 'node:zlib'
import { join, resolve } from 'node:path'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { archiveLicenseTexts, parseReleaseClasspath, validateNativeCoverage, androidReleaseNotices } from './android-release-notices.mjs'

function archive(entries, compressed = false) {
  const chunks = [], records = []
  let offset = 0
  for (const [name, value] of entries) {
    const plain = Buffer.from(value), bytes = compressed ? deflateRawSync(plain) : plain, filename = Buffer.from(name)
    const local = Buffer.alloc(30), central = Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(compressed ? 8 : 0, 8); local.writeUInt32LE(crc32(plain), 14)
    local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(plain.length, 22); local.writeUInt16LE(filename.length, 26)
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(compressed ? 8 : 0, 10); central.writeUInt32LE(crc32(plain), 16)
    central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(plain.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42)
    chunks.push(local, filename, bytes); records.push(central, filename); offset += local.length + filename.length + bytes.length
  }
  const directory = Buffer.concat(records), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, directory, end])
}
const artifact = { group: 'example.library', name: 'runtime', version: '1.0', classifier: null, type: 'jar', file: resolve('runtime.jar') }
const response = artifacts => 'Gradle output\nIROH_RELEASE_DEPENDENCIES=' + JSON.stringify({ schemaVersion: 1, configuration: 'releaseRuntimeClasspath', nativeEnabled: true, artifacts }) + '\nBUILD SUCCESSFUL'
const nativePackage = { name: 'example-native', version: '1.0.0', source: 'registry+official' }
const nativeInventory = { schemaVersion: 1, lockfileSha256: 'a'.repeat(64), packages: [{ ...nativePackage, licenses: [{ sha256: 'b'.repeat(64) }] }] }

test('copies stored and deflated original legal texts, including notices inside AAR classes.jar', () => {
  const aar = archive([['LICENSE.txt', 'original license\n'], ['classes.jar', archive([['META-INF/NOTICE.txt', 'original notice\n']], true)], ['implementation.class', 'not copied']], true)
  const selected = archiveLicenseTexts(aar)
  assert.deepEqual(selected.map(item => [item.file, item.text]), [['LICENSE.txt', 'original license\n'], ['classes.jar!/META-INF/NOTICE.txt', 'original notice\n']])
  assert.ok(selected.every(item => /^[a-f0-9]{64}$/u.test(item.sha256)))
})
test('rejects duplicate names, path traversal, checksum changes and oversized legal records', () => {
  assert.throws(() => archiveLicenseTexts(archive([['LICENSE', 'one'], ['LICENSE', 'two']])), /duplicate/u)
  assert.throws(() => archiveLicenseTexts(archive([['../LICENSE', 'one']])), /member/u)
  const corrupt = archive([['LICENSE', 'one']]); corrupt[37] ^= 1
  assert.throws(() => archiveLicenseTexts(corrupt), /checksum/u)
  assert.throws(() => archiveLicenseTexts(archive([['LICENSE', Buffer.alloc(2 * 1024 * 1024 + 1)]])), /member/u)
})
test('rejects truncated archives and unbounded nested jars', () => {
  const zip = archive([['LICENSE', 'text']])
  assert.throws(() => archiveLicenseTexts(zip.subarray(0, -1)), /end/u)
  assert.throws(() => archiveLicenseTexts(archive([['classes.jar', archive([['classes.jar', archive([['classes.jar', zip]])]])]])), /size/u)
})
test('accepts only one actual native release classpath response', () => {
  assert.deepEqual(parseReleaseClasspath(response([artifact])), [artifact])
  assert.throws(() => parseReleaseClasspath(response([artifact]).replace('releaseRuntimeClasspath', 'debugRuntimeClasspath')), /invalid/u)
  assert.throws(() => parseReleaseClasspath(response([artifact]).replace('"nativeEnabled":true', '"nativeEnabled":false')), /invalid/u)
  assert.throws(() => parseReleaseClasspath(response([artifact]) + '\n' + response([artifact])), /response/u)
})
test('rejects empty, duplicate, non archive and relative-path artifacts', () => {
  assert.throws(() => parseReleaseClasspath(response([])), /invalid/u)
  assert.throws(() => parseReleaseClasspath(response([artifact, artifact])), /duplicate/u)
  assert.throws(() => parseReleaseClasspath(response([{ ...artifact, file: 'relative.jar' }])), /invalid/u)
  assert.throws(() => parseReleaseClasspath(response([{ ...artifact, type: 'exe' }])), /invalid/u)
})
test('native target coverage rejects stale locks and any missing full legal text', () => {
  validateNativeCoverage(nativeInventory, [nativePackage], 'a'.repeat(64))
  assert.throws(() => validateNativeCoverage(nativeInventory, [nativePackage], 'c'.repeat(64)), /stale/u)
  assert.throws(() => validateNativeCoverage({ ...nativeInventory, packages: [] }, [nativePackage], 'a'.repeat(64)), /missing/u)
  assert.throws(() => validateNativeCoverage({ ...nativeInventory, packages: [{ ...nativePackage, licenses: [] }] }, [nativePackage], 'a'.repeat(64)), /missing/u)
})
test('bundles original project, Maven and native notices without local paths or invented copyright', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'iroh-android-notices-'))
  try {
    await mkdir(join(directory, 'scripts'))
    await writeFile(join(directory, 'scripts/android-release-license-sources.json'), '{}\n')
    await writeFile(join(directory, 'LICENSE'), 'Original project copyright\n')
    const jar = join(directory, 'example.jar')
    await writeFile(jar, archive([['META-INF/NOTICE', 'Original upstream copyright\n']]))
    const result = await androidReleaseNotices(directory, [{ ...artifact, file: jar }], { nativeInventory,
      nativeText: 'THIRD-PARTY SOFTWARE NOTICES\n' + 'Original native license\n'.repeat(60), selectedNative: [nativePackage], lockfileSha256: 'a'.repeat(64) })
    assert.match(result.notice, /Original project copyright/u)
    assert.match(result.notice, /Original upstream copyright/u)
    assert.match(result.notice, /Original native license/u)
    assert.ok(!JSON.stringify(result).includes(directory))
    assert.equal(result.metadata.mavenPackages.length, 1)
    await writeFile(jar, archive([['implementation.class', 'code']]))
    await assert.rejects(androidReleaseNotices(directory, [{ ...artifact, file: jar }], { nativeInventory,
      nativeText: result.notice.replace(/^.*?\n/u, 'THIRD-PARTY SOFTWARE NOTICES\n'), selectedNative: [nativePackage], lockfileSha256: 'a'.repeat(64) }), /text_missing/u)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('fallback preserves every original LICENSE and NOTICE and rejects changed upstream bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'iroh-android-pinned-notices-'))
  try {
    await mkdir(join(directory, 'scripts'))
    const originals = ['License text as distributed upstream\n'.repeat(8), 'Copyright (c) Original Author\nOriginal NOTICE\n'.repeat(4)]
    const files = originals.map((text, index) => ({ file: index ? 'NOTICE' : 'LICENSE',
      url: `https://raw.githubusercontent.com/example/project/${'a'.repeat(40)}/${index ? 'NOTICE' : 'LICENSE'}`,
      sha256: createHash('sha256').update(text).digest('hex') }))
    await writeFile(join(directory, 'scripts/android-release-license-sources.json'), JSON.stringify({
      sources: { original: { files } }, packages: { 'example.library:runtime:1.0': 'original' },
    }))
    const jar = join(directory, 'example.jar'); await writeFile(jar, archive([['implementation.class', 'code']]))
    const options = { nativeInventory, nativeText: 'THIRD-PARTY SOFTWARE NOTICES\n' + 'Native license\n'.repeat(100),
      selectedNative: [nativePackage], lockfileSha256: 'a'.repeat(64),
      fetchText: async url => ({ ok: true, arrayBuffer: async () => Buffer.from(originals[files.findIndex(file => file.url === url)]) }) }
    const result = await androidReleaseNotices(directory, [{ ...artifact, file: jar }], options)
    originals.forEach(text => assert.ok(result.notice.includes(text.trimEnd())))
    assert.equal(result.metadata.mavenPackages[0].licenses.length, 2)
    await assert.rejects(androidReleaseNotices(directory, [{ ...artifact, file: jar }], {
      ...options, fetchText: async () => ({ ok: true, arrayBuffer: async () => Buffer.from('changed upstream bytes\n'.repeat(20)) }),
    }), /source_hash/u)
    const cacheDirectory = join(directory, 'cache'); await mkdir(cacheDirectory)
    await androidReleaseNotices(directory, [{ ...artifact, file: jar }], { ...options, cacheDirectory })
    const fromCache = await androidReleaseNotices(directory, [{ ...artifact, file: jar }], {
      ...options, cacheDirectory, fetchText: async () => { assert.fail('Verified cached texts must not need the network') },
    })
    assert.equal(fromCache.notice, result.notice)
    await writeFile(join(cacheDirectory, `${files[0].sha256}.txt`), 'corrupt cached legal text')
    await assert.rejects(androidReleaseNotices(directory, [{ ...artifact, file: jar }], { ...options, cacheDirectory }), /source_hash/u)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
