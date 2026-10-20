package io.github.sayach.dshmobileiroh

import java.io.ByteArrayInputStream
import java.io.IOException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.Base64
import org.json.JSONObject

/** Non-secret persisted routing metadata; it cannot authorize an unpaired HTTPS request. */
internal data class IrohDeviceBinding(val endpointId: String, val localPort: Int) {
    val origin: GatewayOrigin
        get() = GatewayOrigin.parse("https://${endpointId.take(32)}.${endpointId.drop(32)}.iroh.localhost:$localPort")
            ?: throw IOException("Invalid iroh device origin")

    fun isValid(): Boolean = HEX.matches(endpointId) && localPort in 1024..65535

    companion object {
        private val HEX = Regex("^[a-f0-9]{64}$")
        fun isIrohHost(host: String): Boolean = host == "iroh.localhost" || host.endsWith(".iroh.localhost")
    }
}

/** The two one-time pairing secrets never belong in saved device records or logs. */
internal class IrohPairingDescriptor private constructor(
    val binding: IrohDeviceBinding,
    val irohCode: String,
    val gatewayToken: String,
    val caCertificate: ByteArray,
    val instanceId: String,
    val expiresAt: Long,
) {
    override fun toString(): String = "IrohPairingDescriptor(redacted)"

    companion object {
        const val MAX_BYTES = 2200
        private const val MAX_CA_BYTES = 1536
        private const val MAX_LIFETIME_MS = 600_000L
        private val HEX = Regex("^[a-f0-9]{64}$")
        private val CODE = Regex("^[0-9]{6}$")
        private val TOKEN = Regex("^[A-Za-z0-9_-]{43}$")
        private val FIELDS = setOf("version", "type", "endpointId", "origin", "localPort", "irohCode", "gatewayToken", "caCertificate", "instanceId", "expiresAt")
        private val KEY = Regex(""""(?:[^"\\]|\\[\s\S])*"\s*:""")
        private const val JSON_STRING = "\"(?:[^\"\\\\\\x00-\\x1f]|\\\\(?:[\"\\\\/bfnrt]|u[0-9a-fA-F]{4}))*\""
        private const val JSON_NUMBER = "-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?"
        private const val WS = "[ \\t\\r\\n]*"
        // Android JSONObject accepts non-JSON syntax; the shared QR protocol does not.
        private val FLAT_JSON = Regex("\\A$WS\\{$WS(?:$JSON_STRING$WS:$WS(?:$JSON_STRING|$JSON_NUMBER)$WS(?:,$WS$JSON_STRING$WS:$WS(?:$JSON_STRING|$JSON_NUMBER)$WS)*)?}$WS\\z")

        /** Validate exact flat fields, the scanned CA, full peer origin and a short future expiry. */
        fun parse(encoded: String, now: Long = System.currentTimeMillis()): IrohPairingDescriptor {
            fun reject(): Nothing = throw IOException("Invalid or expired iroh pairing information")
            if (now !in 0L..9_007_199_254_740_991L || encoded.toByteArray(Charsets.UTF_8).size > MAX_BYTES || !FLAT_JSON.matches(encoded)) reject()
            val json = try { JSONObject(encoded) } catch (_: Exception) { reject() }
            if (json.keys().asSequence().toSet() != FIELDS || KEY.findAll(encoded).count() != FIELDS.size) reject()
            if (integer(json.opt("version")) != 1L || json.opt("type") != "dsh-mobile-iroh-pairing") reject()
            val peer = json.opt("endpointId") as? String ?: reject()
            val port = integer(json.opt("localPort"))?.takeIf { it in 1024L..65535L }?.toInt() ?: reject()
            val binding = IrohDeviceBinding(peer, port)
            if (!binding.isValid() || json.opt("origin") != binding.origin.serialized) reject()
            val code = (json.opt("irohCode") as? String)?.takeIf(CODE::matches) ?: reject()
            val token = (json.opt("gatewayToken") as? String)?.takeIf(TOKEN::matches) ?: reject()
            if (runCatching { Base64.getUrlEncoder().withoutPadding().encodeToString(Base64.getUrlDecoder().decode(token)) }.getOrNull() != token) reject()
            val instance = (json.opt("instanceId") as? String)?.takeIf(HEX::matches) ?: reject()
            val expiry = integer(json.opt("expiresAt"))?.takeIf { it > now && it - now <= MAX_LIFETIME_MS } ?: reject()
            val caText = json.opt("caCertificate") as? String ?: reject()
            if (caText.isEmpty() || caText.length > 2048) reject()
            val der = runCatching { Base64.getDecoder().decode(caText) }.getOrNull() ?: reject()
            if (der.isEmpty() || der.size > MAX_CA_BYTES || Base64.getEncoder().encodeToString(der) != caText) reject()
            val ca = runCatching {
                CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(der)) as X509Certificate
            }.getOrNull() ?: reject()
            if (!ca.encoded.contentEquals(der) || ca.basicConstraints < 0
                || ca.subjectX500Principal != ca.issuerX500Principal
                || now < ca.notBefore.time || expiry > ca.notAfter.time
                || PairingTrust.fingerprint(ca) != instance) reject()
            try { ca.verify(ca.publicKey) } catch (_: Exception) { reject() }
            return IrohPairingDescriptor(binding, code, token, der, instance, expiry)
        }

        private fun integer(value: Any?): Long? {
            val number = value as? Number ?: return null
            val numeric = number.toDouble()
            if (!numeric.isFinite() || numeric < 0 || numeric > 9_007_199_254_740_991.0 || numeric % 1.0 != 0.0) return null
            return numeric.toLong()
        }
    }
}
