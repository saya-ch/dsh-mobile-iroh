package io.github.sayach.dshmobileiroh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** Covers list probes completing after revocation or replacement of the paired credential. */
class PairedDeviceStatusPolicyTest {
    private val requested = PairedDeviceRecord(
        instanceId = "a".repeat(64),
        deviceId = "b".repeat(32),
        displayName = "Work computer",
        mode = AccessMode.REMOTE,
        origin = GatewayOrigin.parse("https://remote.cpolar.cn")!!,
        deviceToken = "A".repeat(43),
        expiresAt = 10_000L,
        caCertificate = null,
        lastConnectedAt = 1_000L,
        lastReachableAt = 900L,
        status = PairedDeviceStatus.UNKNOWN,
    )
    private val probe = NativeProbe(requested.origin, requested.instanceId, requested.deviceId, 20_000L)

    @Test
    fun explicitRecheckRetainsKnownRevocation() {
        val revoked = requested.copy(status = PairedDeviceStatus.REVOKED)
        assertSame(revoked, PairedDeviceStatusPolicy.beginCheck(revoked))
        PairedDeviceStatus.entries.filter { it != PairedDeviceStatus.REVOKED }.forEach { status ->
            assertEquals(PairedDeviceStatus.UNKNOWN, PairedDeviceStatusPolicy.beginCheck(requested.copy(status = status)).status)
        }
    }

    @Test
    fun aLateProbeCannotReplaceAnOnlineRevocationWithAnyResult() {
        val revoked = requested.copy(status = PairedDeviceStatus.REVOKED)
        assertSame(revoked, PairedDeviceStatusPolicy.applyProbe(revoked, requested, probe, null, 2_000L))
        NativeAuthFailureKind.entries.forEach { failure ->
            assertSame(revoked, PairedDeviceStatusPolicy.applyProbe(revoked, requested, null, failure, 2_000L))
        }
        assertSame(revoked, PairedDeviceStatusPolicy.applyProbe(revoked, requested, null, null, 2_000L))
    }

    @Test
    fun replacedCredentialsRejectThePriorProbesSuccessAndRevocation() {
        val replacements = listOf(
            requested.copy(deviceToken = "B".repeat(43)),
            requested.copy(deviceId = "c".repeat(32)),
            requested.copy(origin = GatewayOrigin.parse("https://new.cpolar.cn")!!),
            requested.copy(caCertificate = byteArrayOf(1, 2, 3)),
            requested.copy(instanceId = "c".repeat(64)),
            requested.copy(mode = AccessMode.LAN),
        )
        replacements.forEach { replacement ->
            assertFalse(PairedDeviceStatusPolicy.mayApplyResult(replacement, requested))
            assertSame(replacement, PairedDeviceStatusPolicy.applyProbe(replacement, requested, probe, null, 2_000L))
            assertSame(replacement, PairedDeviceStatusPolicy.applyProbe(
                replacement, requested, null, NativeAuthFailureKind.DEVICE_REVOKED, 2_000L,
            ))
        }
    }

    @Test
    fun theCurrentCredentialCanProbeAfterRePairingWithoutRestoringTheOldRevocation() {
        val replacement = requested.copy(deviceToken = "B".repeat(43), deviceId = "c".repeat(32))
        val currentProbe = probe.copy(deviceId = replacement.deviceId)
        val updated = PairedDeviceStatusPolicy.applyProbe(replacement, replacement, currentProbe, null, 2_000L)
        assertEquals(PairedDeviceStatus.REACHABLE, updated.status)
        assertEquals(20_000L, updated.expiresAt)
        assertEquals(2_000L, updated.lastReachableAt)
    }

    @Test
    fun concurrentRenameAndTimestampUpdatesDoNotInvalidateTheCredential() {
        val current = requested.copy(displayName = "Renamed", lastConnectedAt = 1_500L, expiresAt = 15_000L)
        assertTrue(PairedDeviceStatusPolicy.mayApplyResult(current, requested))
        val updated = PairedDeviceStatusPolicy.applyProbe(current, requested, probe, null, 2_000L)
        assertEquals("Renamed", updated.displayName)
        assertEquals(1_500L, updated.lastConnectedAt)
        assertEquals(2_000L, updated.lastReachableAt)
    }

    @Test
    fun equalPinnedCertificateBytesStillMatchButReplacedTrustDoesNot() {
        val pinned = requested.copy(caCertificate = byteArrayOf(1, 2, 3))
        assertTrue(PairedDeviceStatusPolicy.mayApplyResult(pinned.copy(caCertificate = byteArrayOf(1, 2, 3)), pinned))
        assertFalse(PairedDeviceStatusPolicy.mayApplyResult(pinned.copy(caCertificate = byteArrayOf(1, 2, 4)), pinned))
        assertFalse(PairedDeviceStatusPolicy.mayApplyResult(pinned.copy(caCertificate = null), pinned))
    }

    @Test
    fun genericAuthenticationFailureIsNotInventedAsRevocation() {
        assertEquals(PairedDeviceStatus.REVOKED, PairedDeviceStatusPolicy.applyProbe(
            requested, requested, null, NativeAuthFailureKind.DEVICE_REVOKED, 2_000L,
        ).status)
        listOf(NativeAuthFailureKind.DEVICE_EXPIRED, NativeAuthFailureKind.PAIRING_EXPIRED).forEach { failure ->
            assertEquals(PairedDeviceStatus.EXPIRED, PairedDeviceStatusPolicy.applyProbe(
                requested, requested, null, failure, 2_000L,
            ).status)
        }
        assertEquals(PairedDeviceStatus.UNREACHABLE, PairedDeviceStatusPolicy.applyProbe(
            requested, requested, null, NativeAuthFailureKind.NETWORK, 2_000L,
        ).status)
    }

    @Test
    fun aForeignDeviceIdMarksTheAddressChangedAndNeverRecordsReachability() {
        val updated = PairedDeviceStatusPolicy.applyProbe(
            requested, requested, probe.copy(deviceId = "c".repeat(32)), null, 2_000L,
        )
        assertEquals(PairedDeviceStatus.ADDRESS_CHANGED, updated.status)
        assertEquals(requested.deviceId, updated.deviceId)
        assertEquals(requested.lastReachableAt, updated.lastReachableAt)
    }

    @Test
    fun aSuccessfulLegacyProbeBindsThePreviouslyUnknownDeviceId() {
        val legacy = requested.copy(deviceId = "")
        val updated = PairedDeviceStatusPolicy.applyProbe(legacy, legacy, probe, null, 2_000L)
        assertEquals(probe.deviceId, updated.deviceId)
        assertEquals(PairedDeviceStatus.REACHABLE, updated.status)
    }

    @Test
    fun anotherProbeMayBindALegacyRowWhileItsRenewalIsInFlight() {
        val legacy = requested.copy(deviceId = "")
        assertTrue(PairedDeviceStatusPolicy.mayApplyResult(requested, legacy))
        assertFalse(PairedDeviceStatusPolicy.mayApplyResult(requested.copy(deviceToken = "B".repeat(43)), legacy))
        assertEquals(PairedDeviceStatus.REACHABLE, PairedDeviceStatusPolicy.applyProbe(
            requested, legacy, probe, null, 2_000L,
        ).status)
    }
}
