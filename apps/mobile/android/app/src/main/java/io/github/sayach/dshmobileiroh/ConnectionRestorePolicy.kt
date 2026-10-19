package io.github.sayach.dshmobileiroh

/** The gateway transport selected by the user for the most recent successful connection. */
internal enum class AccessMode {
    LAN,
    REMOTE,
    ;

    companion object {
        fun parse(value: String?): AccessMode? = entries.firstOrNull { it.name == value }
    }
}

/** App launch destination; direct DSH keeps the existing single-device flow. */
internal enum class LaunchBehavior {
    DIRECT_DSH,
    DEVICE_LIST,
    ;

    companion object {
        fun parse(value: String?): LaunchBehavior? = entries.firstOrNull { it.name == value }
    }
}

/** Whether a failed trusted-session renewal is worth retrying without user input. */
internal enum class RestoreFailureDisposition {
    RETRY_TRANSIENT,
    REQUIRE_USER_ACTION,
}

/** Selects paired devices and classifies trusted-session restore failures. */
internal object ConnectionRestorePolicy {
    /** Select the saved or most recently used device for direct startup. */
    fun selectStartupDevice(
        devices: List<PairedDeviceRecord>,
        savedKey: String?,
        preferredMode: AccessMode?,
        now: Long,
    ): PairedDeviceRecord? {
        val usable = devices.filter {
            it.status != PairedDeviceStatus.REVOKED
                && it.status != PairedDeviceStatus.EXPIRED
                && it.status != PairedDeviceStatus.ADDRESS_CHANGED
                && it.expiresAt > now
        }
        return usable.firstOrNull { it.key == savedKey }
            ?: usable.filter { it.lastConnectedAt != null }.maxWithOrNull(
                compareBy<PairedDeviceRecord> { it.lastConnectedAt ?: Long.MIN_VALUE }
                    .thenBy { it.key },
            )
            ?: preferredMode?.let { mode -> usable.firstOrNull { it.mode == mode } }
            ?: usable.firstOrNull()
    }

    /** Send a persisted bearer credential only to the exact remote origin that previously received it. */
    fun shouldRenewBeforePairing(
        mode: AccessMode,
        credential: DeviceCredential?,
        instanceId: String,
        candidateOrigin: GatewayOrigin,
        savedOrigin: GatewayOrigin?,
        now: Long,
    ): Boolean = mode == AccessMode.REMOTE && credential != null && credential.expiresAt > now
        && credential.instanceId == instanceId && candidateOrigin == savedOrigin

    fun mayPairAfterRenewFailure(failure: Throwable): Boolean =
        (failure as? NativeAuthFailure)?.kind in setOf(
            NativeAuthFailureKind.PAIRING_EXPIRED,
            NativeAuthFailureKind.DEVICE_REVOKED,
            NativeAuthFailureKind.DEVICE_EXPIRED,
        )

    fun failureDisposition(
        failure: Throwable?,
        instanceMismatch: Boolean,
    ): RestoreFailureDisposition {
        if (instanceMismatch) return RestoreFailureDisposition.REQUIRE_USER_ACTION
        return when ((failure as? NativeAuthFailure)?.kind) {
            NativeAuthFailureKind.TIMEOUT,
            NativeAuthFailureKind.NETWORK,
            NativeAuthFailureKind.SERVER_UNAVAILABLE,
            -> RestoreFailureDisposition.RETRY_TRANSIENT
            else -> RestoreFailureDisposition.REQUIRE_USER_ACTION
        }
    }
}
