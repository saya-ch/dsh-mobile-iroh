import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyAndroidReleaseReport } from './verify-android-release.mjs'

test('Android release verification rejects unsigned, debug, main-Mobile and multiple signers', () => {
  const signing = { applicationId: 'io.github.sayach.dshmobileiroh', productionMobileSignerUsed: false, certificateSha256: 'a'.repeat(64) }
  const report = `Verifies\nNumber of signers: 1\nSigner #1 certificate SHA-256 digest: ${signing.certificateSha256}\n`
  assert.doesNotThrow(() => verifyAndroidReleaseReport(report, signing))
  for (const changed of [report.replace('Verifies', 'Does not verify'), report.replace('signers: 1', 'signers: 2'),
    report.replace(signing.certificateSha256, 'b'.repeat(64)), report + `Signer #2 certificate SHA-256 digest: ${'c'.repeat(64)}\n`]) {
    assert.throws(() => verifyAndroidReleaseReport(changed, signing), /signer_mismatch/)
  }
  assert.throws(() => verifyAndroidReleaseReport(report, { ...signing, productionMobileSignerUsed: true }), /pin_invalid/)
})
