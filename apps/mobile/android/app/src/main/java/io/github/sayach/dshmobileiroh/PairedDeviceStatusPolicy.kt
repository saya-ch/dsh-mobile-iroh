package io.github.sayach.dshmobileiroh

/** Applies reachability observations only to the authorization that requested them. */
internal object PairedDeviceStatusPolicy {
    /** Computer-side revocation remains visible until pairing replaces the credential. */
    fun beginCheck(current: PairedDeviceRecord): PairedDeviceRecord =
        if (current.status == PairedDeviceStatus.REVOKED) current else current.copy(status = PairedDeviceStatus.UNKNOWN)

    /** Rejects a late result after revocation, re-pairing, or an origin/trust-anchor change. */
    fun mayApplyResult(current: PairedDeviceRecord, requested: PairedDeviceRecord): Boolean =
        current.status != PairedDeviceStatus.REVOKED && current.key == requested.key &&
            (requested.deviceId.isEmpty() || current.deviceId == requested.deviceId) &&
            current.deviceToken == requested.deviceToken &&
            current.origin == requested.origin && sameCertificate(current.caCertificate, requested.caCertificate)

    /** Preserves names and connection times while updating a current probe's status. */
    fun applyProbe(
        current: PairedDeviceRecord,
        requested: PairedDeviceRecord,
        probe: NativeProbe?,
        failure: NativeAuthFailureKind?,
        now: Long,
    ): PairedDeviceRecord {
        if (!mayApplyResult(current, requested)) return current
        val status = when {
            probe != null && (current.deviceId.isEmpty() || probe.deviceId == current.deviceId) -> PairedDeviceStatus.REACHABLE
            probe != null -> PairedDeviceStatus.ADDRESS_CHANGED
            failure == NativeAuthFailureKind.DEVICE_REVOKED -> PairedDeviceStatus.REVOKED
            failure == NativeAuthFailureKind.DEVICE_EXPIRED || failure == NativeAuthFailureKind.PAIRING_EXPIRED -> PairedDeviceStatus.EXPIRED
            else -> PairedDeviceStatus.UNREACHABLE
        }
        return current.copy(
            deviceId = if (probe != null && current.deviceId.isEmpty()) probe.deviceId else current.deviceId,
            expiresAt = probe?.deviceExpiresAt ?: current.expiresAt,
            status = status,
            lastReachableAt = if (status == PairedDeviceStatus.REACHABLE) now else current.lastReachableAt,
        )
    }

    private fun sameCertificate(left: ByteArray?, right: ByteArray?): Boolean =
        if (left == null) right == null else right != null && left.contentEquals(right)
}
