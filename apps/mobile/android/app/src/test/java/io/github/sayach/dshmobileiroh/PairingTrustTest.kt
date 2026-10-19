package io.github.sayach.dshmobileiroh

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Test

class PairingTrustTest {
    private val instanceId = TestCertificates.instanceIdOf(TestCertificates.ingressCa)
    private val publicKey = PairingKey(instanceId, "B".repeat(43))
    private val caRequiredKey = publicKey.copy(requiresCa = true)

    @Test
    fun expiredAuthenticPinsRemainReadableButCannotAuthorizeANewTlsConnection() {
        val expired = TestCertificates.expiredCa
        val fingerprint = TestCertificates.instanceIdOf(expired)
        assertArrayEquals(expired, PairingTrust.validateStoredCertificate(expired, fingerprint))
        assertNull(PairingTrust.validateStoredCertificate(expired, "b".repeat(64)))
        assertNull(PairingTrust.validateCertificate(expired, fingerprint))
        assertNull(PairingTrust.selectTrustAnchor(AccessMode.LAN, PairingKey(fingerprint, "T".repeat(43))) { expired })
        assertThrows(javax.net.ssl.SSLException::class.java) { PinnedTls.socketFactory(expired) }
        assertNotNull(PinnedTls.socketFactory(TestCertificates.ingressCa))
    }

    @Test
    fun parsesFingerprintBoundPairingKey() {
        val instanceId = "a".repeat(64)
        val token = "B".repeat(43)
        assertEquals(PairingKey(instanceId, token), PairingKey.parse("dsh1.$instanceId.$token"))
        assertEquals(PairingKey(instanceId, token, requiresCa = true), PairingKey.parse("dsh2.$instanceId.$token"))
    }

    @Test
    fun rejectsLegacyOrMalformedKeys() {
        assertNull(PairingKey.parse("B".repeat(43)))
        assertNull(PairingKey.parse("dsh1.${"g".repeat(64)}.${"B".repeat(43)}"))
        assertNull(PairingKey.parse("dsh3.${"a".repeat(64)}.${"B".repeat(43)}"))
    }

    // `selectTrustAnchor` is the single entry point the pairing flow uses. The LAN rows below must
    // keep their pre-existing semantics line by line; the REMOTE rows are the self-signed fix.

    @Test
    fun lanPinsTheCaItFetchesFromTheGateway() {
        val trust = PairingTrust.selectTrustAnchor(AccessMode.LAN, publicKey) { TestCertificates.ingressCa }

        assertEquals(instanceId, trust?.second)
        assertArrayEquals(TestCertificates.ingressCa, trust?.first)
    }

    @Test
    fun lanStillFailsWhenTheGatewayServesNoCa() {
        assertNull(PairingTrust.selectTrustAnchor(AccessMode.LAN, publicKey) { null })
    }

    @Test
    fun lanStillFailsWhenTheServedCaIsNotThePromisedOne() {
        assertNull(PairingTrust.selectTrustAnchor(AccessMode.LAN, publicKey) { TestCertificates.foreignCa })
        assertNull(PairingTrust.selectTrustAnchor(AccessMode.LAN, publicKey) { "not a certificate".toByteArray() })
    }

    @Test
    fun remotePinsTheSelfSignedIngressCa() {
        val trust = PairingTrust.selectTrustAnchor(AccessMode.REMOTE, caRequiredKey) { TestCertificates.ingressCa }

        assertEquals(instanceId, trust?.second)
        assertArrayEquals(TestCertificates.ingressCa, trust?.first)
    }

    @Test
    fun remoteKeepsThePlatformTrustStoreWhenTheEntryServesNoCa() {
        // A Caddy + Let's Encrypt entry answers 404 here: identical behaviour to the release that
        // never pinned anything remotely, and explicitly not an error.
        val trust = PairingTrust.selectTrustAnchor(AccessMode.REMOTE, publicKey) { null }

        assertEquals(instanceId, trust?.second)
        assertNull(trust?.first)
    }

    @Test
    fun remoteCaRequiredKeyCannotDowngradeOnMissingCa() {
        assertNull(PairingTrust.selectTrustAnchor(AccessMode.REMOTE, caRequiredKey) { null })
    }

    @Test
    fun aPreviouslyPinnedRemoteCaCannotDowngradeWhenRepairedWithDsh1() {
        val key = PairingTrust.preserveRemotePin(AccessMode.REMOTE, publicKey, TestCertificates.ingressCa)

        assertEquals(caRequiredKey, key)
        assertNull(PairingTrust.selectTrustAnchor(AccessMode.REMOTE, key) { null })
        assertEquals(publicKey, PairingTrust.preserveRemotePin(AccessMode.REMOTE, publicKey, null))
        assertEquals(publicKey, PairingTrust.preserveRemotePin(AccessMode.LAN, publicKey, TestCertificates.ingressCa))
    }

    @Test
    fun remoteFetchFailuresPropagateInsteadOfBecomingAnAbsentCa() {
        for (kind in listOf(NativeAuthFailureKind.NETWORK, NativeAuthFailureKind.TLS)) {
            val failure = assertThrows(NativeAuthFailure::class.java) {
                PairingTrust.selectTrustAnchor(AccessMode.REMOTE, caRequiredKey) {
                    throw NativeAuthFailure(kind)
                }
            }
            assertEquals(kind, failure.kind)
        }
    }

    @Test
    fun remoteFailsWhenTheServedCaIsNotThePromisedOne() {
        assertNull(PairingTrust.selectTrustAnchor(AccessMode.REMOTE, caRequiredKey) { TestCertificates.foreignCa })
        assertNull(PairingTrust.selectTrustAnchor(AccessMode.REMOTE, caRequiredKey.copy(instanceId = "b".repeat(64))) { TestCertificates.ingressCa })
    }
}
