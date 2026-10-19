package io.github.sayach.dshmobileiroh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Locks which persisted rows may carry which trust anchor.
 *
 * The remote + `null` row is the compatibility gate: entries with a publicly trusted certificate
 * serve no CA and must keep loading exactly as before.
 */
class PairedDeviceRecordPolicyTest {
    private val instanceId = TestCertificates.instanceIdOf(TestCertificates.ingressCa)

    @Test
    fun lanRowsStillRequireTheirPinnedPairingCa() {
        assertTrue(PairedDeviceRecordPolicy.acceptsTrustAnchor(AccessMode.LAN, TestCertificates.ingressCa, instanceId))
        assertFalse(PairedDeviceRecordPolicy.acceptsTrustAnchor(AccessMode.LAN, null, instanceId))
    }

    @Test
    fun lanRowsStillRejectAStaleOrForeignCa() {
        assertFalse(PairedDeviceRecordPolicy.acceptsTrustAnchor(AccessMode.LAN, TestCertificates.foreignCa, instanceId))
        assertFalse(PairedDeviceRecordPolicy.acceptsTrustAnchor(AccessMode.LAN, TestCertificates.ingressCa, "b".repeat(64)))
        assertFalse(PairedDeviceRecordPolicy.acceptsTrustAnchor(AccessMode.LAN, TestCertificates.leafPublicIp, instanceId))
        assertFalse(PairedDeviceRecordPolicy.acceptsTrustAnchor(AccessMode.LAN, "not a certificate".toByteArray(), instanceId))
    }

    @Test
    fun remoteRowsMayPinTheSelfSignedIngressCa() {
        assertTrue(PairedDeviceRecordPolicy.acceptsTrustAnchor(AccessMode.REMOTE, TestCertificates.ingressCa, instanceId))
    }

    @Test
    fun remoteRowsWithoutACaKeepThePublicTrustStore() {
        assertTrue(PairedDeviceRecordPolicy.acceptsTrustAnchor(AccessMode.REMOTE, null, instanceId))
    }

    @Test
    fun remoteRowsStillRejectACaThatIsNotThePromisedOne() {
        assertFalse(PairedDeviceRecordPolicy.acceptsTrustAnchor(AccessMode.REMOTE, TestCertificates.foreignCa, instanceId))
        assertFalse(PairedDeviceRecordPolicy.acceptsTrustAnchor(AccessMode.REMOTE, TestCertificates.ingressCa, "b".repeat(64)))
        assertFalse(PairedDeviceRecordPolicy.acceptsTrustAnchor(AccessMode.REMOTE, TestCertificates.leafPublicIp, instanceId))
    }

    @Test
    fun thePersistedRowMatrixIsUnchangedForEveryPublicCaEntry() {
        // A row that pins nothing keeps loading for both modes' public-trust case: for LAN the
        // pairing flow always supplies a CA, so only REMOTE may legitimately stay null.
        val matrix: List<Triple<AccessMode, ByteArray?, Boolean>> = listOf(
            Triple(AccessMode.LAN, null, false),
            Triple(AccessMode.REMOTE, null, true),
            Triple(AccessMode.LAN, TestCertificates.ingressCa, true),
            Triple(AccessMode.REMOTE, TestCertificates.ingressCa, true),
        )

        matrix.forEach { (mode, ca, expected) ->
            assertEquals(
                "$mode with a ${if (ca == null) "null" else "pinned"} CA must be $expected",
                expected,
                PairedDeviceRecordPolicy.acceptsTrustAnchor(mode, ca, instanceId),
            )
        }
    }
}