package io.github.sayach.dshmobileiroh

/**
 * How one persisted device row must bind its trust anchor for each access mode.
 *
 * A LAN gateway always serves the pairing CA, so a LAN row must pin it. A remote gateway pins
 * the ingress CA only when the entry is self-signed; an entry with a publicly trusted
 * certificate serves no CA at all and its row keeps the platform trust store (`null`).
 */
internal object PairedDeviceRecordPolicy {
    /**
     * Whether a saved row binds an authentic CA to its instance. Expiry is checked by TLS,
     * not while decoding encrypted records; expired rows remain available for repair/removal.
     *
     * @param mode the transport the row was paired over.
     * @param caCertificate the pinned CA, or `null` when the row uses the platform trust store.
     * @param instanceId the DSH instance the pinned CA must be fingerprinted against.
     */
    fun acceptsTrustAnchor(mode: AccessMode, caCertificate: ByteArray?, instanceId: String): Boolean =
        when (mode) {
            AccessMode.LAN -> caCertificate?.let { PairingTrust.validateStoredCertificate(it, instanceId) != null } == true
            AccessMode.REMOTE -> caCertificate?.let { PairingTrust.validateStoredCertificate(it, instanceId) != null } ?: true
        }
}
