package io.github.sayach.dshmobileiroh

import java.io.ByteArrayInputStream
import java.net.InetAddress
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.SSLException
import javax.net.ssl.TrustManagerFactory

/** App-private TLS trust anchored to the CA fingerprint carried by the pairing key. */
internal object PinnedTls {
    fun socketFactory(caDer: ByteArray): SSLSocketFactory {
        val ca = certificate(caDer)
        try {
            ca.checkValidity()
        } catch (failure: java.security.cert.CertificateException) {
            throw SSLException("Pinned CA is outside its validity period", failure)
        }
        val store = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
            load(null)
            setCertificateEntry("dsh-mobile", ca)
        }
        val managers = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply {
            init(store)
        }.trustManagers
        return SSLContext.getInstance("TLS").apply { init(null, managers, null) }.socketFactory
    }

    fun acceptsWebViewLeaf(origin: GatewayOrigin, caDer: ByteArray, leaf: X509Certificate?): Boolean = runCatching {
        require(leaf != null)
        val ca = certificate(caDer)
        ca.checkValidity()
        leaf.checkValidity()
        require(ca.basicConstraints >= 0 && leaf.basicConstraints < 0)
        require(leaf.issuerX500Principal == ca.subjectX500Principal)
        leaf.verify(ca.publicKey)
        val usages = leaf.extendedKeyUsage
        require(usages == null || SERVER_AUTH in usages)
        require(matchesSubjectAlternativeName(origin.host, leaf))
        true
    }.getOrDefault(false)

    private fun certificate(der: ByteArray): X509Certificate = CertificateFactory.getInstance("X.509")
        .generateCertificate(ByteArrayInputStream(der)) as X509Certificate

    private fun matchesSubjectAlternativeName(host: String, certificate: X509Certificate): Boolean {
        val alternatives = certificate.subjectAlternativeNames ?: return false
        if (host.contains(':') || IPV4.matches(host)) {
            val expected = runCatching { InetAddress.getByName(host).address }.getOrNull() ?: return false
            return alternatives.any { alternative ->
                alternative.size >= 2 && alternative[0] == IP_ADDRESS && runCatching {
                    InetAddress.getByName(alternative[1] as String).address.contentEquals(expected)
                }.getOrDefault(false)
            }
        }
        val canonical = host.lowercase()
        return alternatives.any { alternative ->
            if (alternative.size < 2 || alternative[0] != DNS_NAME) return@any false
            val candidate = (alternative[1] as? String)?.lowercase() ?: return@any false
            candidate == canonical || candidate.startsWith("*.")
                && canonical.endsWith(candidate.removePrefix("*"))
                && canonical.count { it == '.' } == candidate.count { it == '.' }
        }
    }

    private const val DNS_NAME = 2
    private const val IP_ADDRESS = 7
    private const val SERVER_AUTH = "1.3.6.1.5.5.7.3.1"
    private val IPV4 = Regex("^(?:\\d{1,3}\\.){3}\\d{1,3}$")
}
