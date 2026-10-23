import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { packageLicenseFiles, verifyLicenseSource } from './release-notices.mjs'
import { createHash } from 'node:crypto'

test('release notices include original license directories and declared files, never source code', async t => {
  const root = await mkdtemp(join(tmpdir(), 'iroh-license-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'LICENSES'))
  await writeFile(join(root, 'LICENSES', 'MIT.txt'), 'Original MIT license\n')
  await writeFile(join(root, 'NOTICE'), 'Original copyright\n')
  await writeFile(join(root, 'LEGAL.txt'), 'Declared legal text\n')
  await writeFile(join(root, 'lib.rs'), 'not a license')
  const files = await packageLicenseFiles(root, 'LEGAL.txt')
  assert.deepEqual(files.map(file => file.file).sort(), ['LEGAL.txt', 'LICENSES/MIT.txt', 'NOTICE'])
  assert(files.every(file => /^[a-f0-9]{64}$/u.test(file.sha256)))
  await assert.rejects(packageLicenseFiles(root, '../outside-license'), /path_escape/)
})

test('a changed upstream legal text cannot replace the reviewed digest', () => {
  const bytes = Buffer.from('Known legal text. '.repeat(20))
  const pin = { sha256: createHash('sha256').update(bytes).digest('hex') }
  assert.equal(verifyLicenseSource(bytes, pin), bytes.toString())
  assert.throws(() => verifyLicenseSource(Buffer.from('Changed legal text. '.repeat(20)), pin), /source_hash/)
})
