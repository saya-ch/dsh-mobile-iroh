package io.github.sayach.dshmobileiroh

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Locks the remote-mode trust decision for the self-signed passthrough entry.
 *
 * The compatibility gate is the middle case: an entry with a publicly trusted certificate serves
 * no `ca.cer` at all, and that must stay a silent fall back to the platform trust store.
 */
class RemotePairingTrustTest {
    private val instanceId = TestCertificates.instanceIdOf(TestCertificates.ingressCa)
    private val publicKey = PairingKey(instanceId, "A".repeat(43))
    private val caRequiredKey = publicKey.copy(requiresCa = true)

    @Test
    fun selfSignedEntryPinsTheCaPromisedByThePairingKey() {
        val decision = RemotePairingTrust.decide(TestCertificates.ingressCa, caRequiredKey)

        assertEquals(PairingTrustAnchor.PINNED_CA, decision.anchor)
        assertArrayEquals(TestCertificates.ingressCa, decision.caCertificate)
    }

    @Test
    fun pinnedBytesAreTheCanonicalEncodingOfTheServedCa() {
        val decision = RemotePairingTrust.decide(TestCertificates.ingressCa, caRequiredKey)

        assertArrayEquals(
            TestCertificates.certificate(TestCertificates.ingressCa).encoded,
            decision.caCertificate,
        )
    }

    @Test
    fun publicCaEntryWithoutCaKeepsTheSystemTrustStoreAndIsNotAnError() {
        // `/mobile-access/ca.cer` answers 404 on a Caddy + Let's Encrypt entry: the fetch yields
        // null and the caller must keep exactly today's platform-trust behaviour.
        val decision = RemotePairingTrust.decide(null, publicKey)

        assertEquals(PairingTrustAnchor.SYSTEM_TRUST_STORE, decision.anchor)
        assertNull(decision.caCertificate)
        assertNotEquals(PairingTrustAnchor.IDENTITY_MISMATCH, decision.anchor)
    }

    @Test
    fun caRequiredKeyRejectsAnAbsentCa() {
        val decision = RemotePairingTrust.decide(null, caRequiredKey)

        assertEquals(PairingTrustAnchor.IDENTITY_MISMATCH, decision.anchor)
        assertNull(decision.caCertificate)
    }

    @Test
    fun substitutedCaIsAnIdentityMismatch() {
        val decision = RemotePairingTrust.decide(TestCertificates.foreignCa, caRequiredKey)

        assertEquals(PairingTrustAnchor.IDENTITY_MISMATCH, decision.anchor)
        assertNull(decision.caCertificate)
    }

    @Test
    fun caWithAMismatchedFingerprintIsAnIdentityMismatch() {
        val decision = RemotePairingTrust.decide(TestCertificates.ingressCa, caRequiredKey.copy(instanceId = "b".repeat(64)))

        assertEquals(PairingTrustAnchor.IDENTITY_MISMATCH, decision.anchor)
        assertNull(decision.caCertificate)
    }

    @Test
    fun aLeafServedInPlaceOfTheCaIsAnIdentityMismatch() {
        // The payload is a real certificate whose own fingerprint matches the pairing key, but it
        // is a leaf, not the CA the entry promised.
        val leafInstanceId = TestCertificates.instanceIdOf(TestCertificates.leafPublicIp)

        val decision = RemotePairingTrust.decide(TestCertificates.leafPublicIp, caRequiredKey.copy(instanceId = leafInstanceId))

        assertEquals(PairingTrustAnchor.IDENTITY_MISMATCH, decision.anchor)
        assertNull(decision.caCertificate)
    }

    @Test
    fun aPayloadThatIsNotACertificateIsAnIdentityMismatch() {
        val decision = RemotePairingTrust.decide("<html>404</html>".toByteArray(), caRequiredKey)

        assertEquals(PairingTrustAnchor.IDENTITY_MISMATCH, decision.anchor)
        assertNull(decision.caCertificate)
    }

    @Test
    fun onlyAnAbsentCaFallsBackToTheSystemTrustStore() {
        val served = listOf(
            TestCertificates.foreignCa,
            TestCertificates.leafPublicIp,
            TestCertificates.leafForeignIssuer,
            "not a certificate".toByteArray(),
            ByteArray(0),
        )

        served.forEach { payload ->
            assertNotEquals(
                "a served payload must never downgrade to the platform trust store",
                PairingTrustAnchor.SYSTEM_TRUST_STORE,
                RemotePairingTrust.decide(payload, caRequiredKey).anchor,
            )
        }
    }
}
