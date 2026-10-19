package io.github.sayach.dshmobileiroh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Verifies paired-device startup selection and trusted-session restore decisions. */
class ConnectionRestorePolicyTest {
    private val now = 1_000L
    private val remoteCredential = credential("b", now + 10_000)

    @Test
    fun directStartupUsesTheMostRecentlyConnectedDeviceWhenNoKeyIsSaved() {
        val devices = listOf(
            pairedDevice("a", AccessMode.LAN, lastConnectedAt = now + 1_000),
            pairedDevice("b", AccessMode.REMOTE, lastConnectedAt = now + 2_000),
        )

        val selected = ConnectionRestorePolicy.selectStartupDevice(
            devices = devices,
            savedKey = null,
            preferredMode = AccessMode.LAN,
            now = now,
        )

        assertEquals("remote:" + "b".repeat(64), selected?.key)
    }

    @Test
    fun directStartupPrefersSavedDeviceAndSkipsRevokedOrChangedRows() {
        val revoked = pairedDevice("a", AccessMode.LAN, lastConnectedAt = now + 3_000, status = PairedDeviceStatus.REVOKED)
        val changed = pairedDevice("b", AccessMode.REMOTE, lastConnectedAt = now + 2_000, status = PairedDeviceStatus.ADDRESS_CHANGED)
        val usable = pairedDevice("c", AccessMode.REMOTE, lastConnectedAt = now + 1_000)

        val selected = ConnectionRestorePolicy.selectStartupDevice(
            devices = listOf(revoked, changed, usable),
            savedKey = changed.key,
            preferredMode = AccessMode.REMOTE,
            now = now,
        )

        assertEquals(usable.key, selected?.key)
    }

    @Test
    fun retriesOnlyFailuresThatCanRecoverWithoutUserInput() {
        val transientKinds = listOf(
            NativeAuthFailureKind.TIMEOUT,
            NativeAuthFailureKind.NETWORK,
            NativeAuthFailureKind.SERVER_UNAVAILABLE,
        )

        transientKinds.forEach { kind ->
            assertEquals(
                RestoreFailureDisposition.RETRY_TRANSIENT,
                ConnectionRestorePolicy.failureDisposition(NativeAuthFailure(kind), instanceMismatch = false),
            )
        }
    }

    @Test
    fun stopsAutomaticRecoveryForPermanentFailuresAndIdentityChanges() {
        val permanentKinds = NativeAuthFailureKind.entries - setOf(
            NativeAuthFailureKind.TIMEOUT,
            NativeAuthFailureKind.NETWORK,
            NativeAuthFailureKind.SERVER_UNAVAILABLE,
        )

        permanentKinds.forEach { kind ->
            assertEquals(
                RestoreFailureDisposition.REQUIRE_USER_ACTION,
                ConnectionRestorePolicy.failureDisposition(NativeAuthFailure(kind), instanceMismatch = false),
            )
        }
        assertEquals(
            RestoreFailureDisposition.REQUIRE_USER_ACTION,
            ConnectionRestorePolicy.failureDisposition(null, instanceMismatch = false),
        )
        assertEquals(
            RestoreFailureDisposition.REQUIRE_USER_ACTION,
            ConnectionRestorePolicy.failureDisposition(
                NativeAuthFailure(NativeAuthFailureKind.NETWORK),
                instanceMismatch = true,
            ),
        )
    }

    @Test
    fun renewsOnlyAtThePreviouslySavedRemoteOrigin() {
        val savedOrigin = GatewayOrigin.parse("https://remote.cpolar.cn")!!
        assertTrue(ConnectionRestorePolicy.shouldRenewBeforePairing(
            AccessMode.REMOTE,
            remoteCredential,
            remoteCredential.instanceId,
            candidateOrigin = savedOrigin,
            savedOrigin = savedOrigin,
            now = now,
        ))
        assertFalse(ConnectionRestorePolicy.shouldRenewBeforePairing(
            AccessMode.REMOTE,
            remoteCredential,
            remoteCredential.instanceId,
            candidateOrigin = GatewayOrigin.parse("https://new-address.cpolar.cn")!!,
            savedOrigin = savedOrigin,
            now = now,
        ))
        // An attacker can copy the public instance id into a QR code. A new
        // HTTPS origin must not receive the existing bearer device token.
        assertFalse(ConnectionRestorePolicy.shouldRenewBeforePairing(
            AccessMode.REMOTE,
            remoteCredential,
            remoteCredential.instanceId,
            candidateOrigin = GatewayOrigin.parse("https://attacker.example.com")!!,
            savedOrigin = savedOrigin,
            now = now,
        ))
        assertFalse(ConnectionRestorePolicy.shouldRenewBeforePairing(
            AccessMode.LAN,
            remoteCredential,
            remoteCredential.instanceId,
            candidateOrigin = savedOrigin,
            savedOrigin = savedOrigin,
            now = now,
        ))
        assertTrue(ConnectionRestorePolicy.mayPairAfterRenewFailure(
            NativeAuthFailure(NativeAuthFailureKind.PAIRING_EXPIRED),
        ))
        assertTrue(ConnectionRestorePolicy.mayPairAfterRenewFailure(
            NativeAuthFailure(NativeAuthFailureKind.DEVICE_REVOKED),
        ))
        assertTrue(ConnectionRestorePolicy.mayPairAfterRenewFailure(
            NativeAuthFailure(NativeAuthFailureKind.DEVICE_EXPIRED),
        ))
        assertEquals(
            false,
            ConnectionRestorePolicy.mayPairAfterRenewFailure(NativeAuthFailure(NativeAuthFailureKind.TIMEOUT)),
        )
    }

    private fun credential(instanceCharacter: String, expiresAt: Long) = DeviceCredential(
        instanceId = instanceCharacter.repeat(64),
        deviceToken = "A".repeat(43),
        expiresAt = expiresAt,
        caCertificate = null,
    )

    private fun pairedDevice(
        instanceCharacter: String,
        mode: AccessMode,
        lastConnectedAt: Long,
        status: PairedDeviceStatus = PairedDeviceStatus.UNKNOWN,
    ) = PairedDeviceRecord(
        instanceId = instanceCharacter.repeat(64),
        deviceId = "c".repeat(32),
        displayName = "Computer",
        mode = mode,
        origin = GatewayOrigin.parse(if (mode == AccessMode.LAN) "https://192.168.1.20:3443" else "https://remote.cpolar.cn")!!,
        deviceToken = "A".repeat(43),
        expiresAt = now + 10_000,
        caCertificate = null,
        lastConnectedAt = lastConnectedAt,
        lastReachableAt = null,
        status = status,
    )
}
