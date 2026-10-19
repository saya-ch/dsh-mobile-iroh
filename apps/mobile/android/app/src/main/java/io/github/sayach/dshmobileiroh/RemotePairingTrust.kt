package io.github.sayach.dshmobileiroh

/** The trust anchor a native pairing request must use for the gateway that was just scanned. */
internal enum class PairingTrustAnchor {
    /** Pin the CA the gateway served, fingerprinted against the pairing key. */
    PINNED_CA,

    /** No CA was served for a dsh1 public-CA entry; keep the platform trust store. */
    SYSTEM_TRUST_STORE,

    /** A required CA is absent or the served CA does not match the pairing key. */
    IDENTITY_MISMATCH,
}

/** The decision taken before any native pairing request is issued. */
internal data class PairingTrustDecision(
    val anchor: PairingTrustAnchor,
    val caCertificate: ByteArray?,
)

/**
 * Remote-mode trust selection for the self-signed passthrough entry.
 *
 * Upstream assumes every remote relay terminates a publicly trusted certificate, so the remote
 * path never pinned a CA and relied on the platform trust store. This fork's self-signed
 * passthrough entry has no public certificate: it publishes its ingress CA at
 * `/mobile-access/ca.cer`, and that CA is exactly the fingerprint the pairing key carries.
 * It must therefore be pinned the same way the LAN path already pins its pairing CA.
 *
 * The three outcomes are deliberately separated, because only two of them are legitimate:
 *  - a served CA that matches the pairing key is pinned;
 *  - an explicit 404 keeps the platform trust store only for a dsh1 public-CA key;
 *  - a dsh2 key with no CA, or a mismatched served CA, is a hard identity mismatch.
 */
internal object RemotePairingTrust {
    /**
     * Decide how the native pairing request must authenticate the gateway.
     *
     * @param fetchedCa the bytes returned by `/mobile-access/ca.cer`, or `null` only for HTTP 404.
     *     Transport, TLS, and server failures must reach the caller as exceptions.
     * @param key the parsed pairing key and its CA requirement.
     * @return the pinned CA, the platform trust store, or an identity mismatch.
     */
    fun decide(fetchedCa: ByteArray?, key: PairingKey): PairingTrustDecision {
        if (fetchedCa == null) {
            return PairingTrustDecision(
                if (key.requiresCa) PairingTrustAnchor.IDENTITY_MISMATCH else PairingTrustAnchor.SYSTEM_TRUST_STORE,
                null,
            )
        }
        // Fail closed: a served payload that is not the promised, self-signed, valid CA is an
        // identity mismatch, never a reason to fall back to the platform trust store.
        val pinned = PairingTrust.validateCertificate(fetchedCa, key.instanceId)
            ?: return PairingTrustDecision(PairingTrustAnchor.IDENTITY_MISMATCH, null)
        return PairingTrustDecision(PairingTrustAnchor.PINNED_CA, pinned)
    }
}
