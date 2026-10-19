package io.github.sayach.dshmobileiroh

import java.io.ByteArrayInputStream
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate

internal data class PairingKey(val instanceId: String, val token: String, val requiresCa: Boolean = false) {
    companion object {
        private val FORMAT = Regex("^dsh([12])\\.([a-f0-9]{64})\\.([A-Za-z0-9_-]{43})$")

        fun parse(source: String): PairingKey? {
            val match = FORMAT.matchEntire(source) ?: return null
            return PairingKey(match.groupValues[2], match.groupValues[3], requiresCa = match.groupValues[1] == "2")
        }
    }
}

internal object PairingTrust {
    /** A saved remote CA remains mandatory when the same computer is paired again. */
    fun preserveRemotePin(mode: AccessMode, key: PairingKey, savedCa: ByteArray?): PairingKey =
        if (mode == AccessMode.REMOTE && savedCa != null) key.copy(requiresCa = true) else key

    /** Validate that the CA is self-signed, valid, and bound to the pairing-key instance id. */
    fun validateCertificate(der: ByteArray, instanceId: String): ByteArray? = runCatching {
        val certificate = certificate(der)
        assertCa(certificate)
        certificate.checkValidity()
        require(fingerprint(certificate) == instanceId)
        certificate.encoded
    }.getOrNull()

    /** Retain an authentic saved pin after expiry so its device can still be repaired or removed. */
    fun validateStoredCertificate(der: ByteArray, instanceId: String): ByteArray? = runCatching {
        val certificate = certificate(der)
        assertCa(certificate)
        require(fingerprint(certificate) == instanceId)
        certificate.encoded
    }.getOrNull()

    /**
     * Select the TLS trust anchor for one pairing attempt, or `null` when the gateway identity
     * cannot be verified against the fingerprint carried by the pairing key.
     *
     * A LAN gateway always serves its pairing CA. A remote dsh2 key also requires the CA;
     * only a public-CA dsh1 remote key may use the platform trust store after an explicit 404.
     * Other fetch failures propagate to the caller.
     *
     * @param mode the transport the user selected for this attempt.
     * @param key the parsed pairing key, including whether a remote CA is mandatory.
     * @param fetchCa reads `/mobile-access/ca.cer` over the re-trust bootstrap channel.
     */
    fun selectTrustAnchor(
        mode: AccessMode,
        key: PairingKey,
        fetchCa: () -> ByteArray?,
    ): Pair<ByteArray?, String?>? = when (mode) {
        AccessMode.LAN -> fetchCa()?.let { ca -> validateCertificate(ca, key.instanceId)?.let { it to key.instanceId } }
        AccessMode.REMOTE -> {
            val decision = RemotePairingTrust.decide(fetchCa(), key)
            if (decision.anchor == PairingTrustAnchor.IDENTITY_MISMATCH) null
            else decision.caCertificate to key.instanceId
        }
    }

    /** SHA-256 fingerprint of the DER certificate, lowercase hex as used by the gateway. */
    fun fingerprint(certificate: X509Certificate): String =
        MessageDigest.getInstance("SHA-256").digest(certificate.encoded)
            .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }

    private fun certificate(der: ByteArray): X509Certificate =
        CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(der)) as X509Certificate

    private fun assertCa(certificate: X509Certificate) {
        require(certificate.basicConstraints >= 0)
        require(certificate.subjectX500Principal == certificate.issuerX500Principal)
        certificate.verify(certificate.publicKey)
    }
}
