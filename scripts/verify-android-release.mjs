import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Verify an already cryptographically checked APK report against this independent application's signer. */
export function verifyAndroidReleaseReport(report, signing) {
  if (signing.applicationId !== 'io.github.sayach.dshmobileiroh' || signing.productionMobileSignerUsed !== false
    || !/^[a-f0-9]{64}$/u.test(signing.certificateSha256)) throw new Error('iroh_android_signing_pin_invalid')
  const lines = report.split(/\r?\n/u).map(line => line.trim())
  const signers = lines.filter(line => line.startsWith('Number of signers:'))
  const digests = lines.filter(line => line.includes('certificate SHA-256 digest:'))
  const pattern = /^(?:Signer #1|V[234](?:\.1)? Signer:) certificate SHA-256 digest: ([a-f\d]{64})$/iu
  if (!lines.includes('Verifies') || signers.length !== 1 || signers[0] !== 'Number of signers: 1'
    || digests.length === 0 || digests.some(line => pattern.exec(line)?.[1]?.toLowerCase() !== signing.certificateSha256)) {
    throw new Error('iroh_android_release_signer_mismatch')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const signing = JSON.parse(await readFile(new URL('../apps/mobile/signing.json', import.meta.url), 'utf8'))
  verifyAndroidReleaseReport(readFileSync(0, 'utf8'), signing)
  console.log('Independent iroh Android release signer verified.')
}
