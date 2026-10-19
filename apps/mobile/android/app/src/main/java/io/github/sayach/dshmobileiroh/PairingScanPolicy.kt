package io.github.sayach.dshmobileiroh

/** A validated pairing link together with the connection mode implied by its host. */
internal data class PairingScanTarget(
    val connection: GatewayConnection,
    val mode: AccessMode,
)

/** Parses pairing QR contents while using the active flow for user-owned remote domains. */
internal object PairingScanPolicy {
    fun parse(rawValue: String, preferredMode: AccessMode? = null): PairingScanTarget? {
        val normalized = rawValue.trim()
        if (GatewayUrlPolicy.pairingKey(normalized) == null) return null
        val connection = GatewayConnection.parse(normalized) ?: return null
        val host = connection.origin.host
        val mode = when {
            RemoteHostPolicy.isSupported(host) -> AccessMode.REMOTE
            preferredMode == AccessMode.REMOTE && RemoteHostPolicy.isRemoteCandidate(host) -> AccessMode.REMOTE
            preferredMode != AccessMode.REMOTE && !RemoteHostPolicy.isRemoteCandidate(host) -> AccessMode.LAN
            else -> return null
        }
        return PairingScanTarget(connection, mode)
    }
}
