package io.github.sayach.dshmobileiroh

import java.io.IOException
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URL
import javax.net.ssl.HttpsURLConnection
import org.json.JSONObject

/** Native metadata is untrusted JNI output until its exact peer, fields and ports are checked. */
internal data class IrohEndpointMetadata(
    val peerId: String,
    val localPort: Int,
    val connectProxyPort: Int,
) {
    val origin: GatewayOrigin
        get() = GatewayOrigin.parse("https://${peerId.take(32)}.${peerId.drop(32)}.iroh.localhost:$localPort")
            ?: throw IOException("Invalid iroh HTTPS origin")

    companion object {
        private val peerPattern = Regex("^[a-f0-9]{64}$")

        fun parse(value: String, expectedPeer: String, expectedLocalPort: Int = 25443): IrohEndpointMetadata {
            if (value.toByteArray(Charsets.UTF_8).size > 2048 || !peerPattern.matches(expectedPeer)) {
                throw IOException("Invalid iroh endpoint metadata")
            }
            val record = try { JSONObject(value) } catch (_: Exception) { throw IOException("Invalid iroh endpoint metadata") }
            if (record.keys().asSequence().toSet() != setOf("version", "peerId", "localPort", "connectProxyPort")
                || record.opt("version") != 1 || record.opt("peerId") != expectedPeer) {
                throw IOException("Invalid iroh endpoint metadata")
            }
            val localPort = record.opt("localPort") as? Int
            val proxyPort = record.opt("connectProxyPort") as? Int
            if (localPort == null || localPort !in 1024..65535 || localPort != expectedLocalPort || proxyPort == null
                || proxyPort !in 1..65535 || localPort == proxyPort) {
                throw IOException("Invalid iroh endpoint ports")
            }
            return IrohEndpointMetadata(expectedPeer, localPort, proxyPort)
        }
    }
}

/**
 * Native HTTPS uses a strict local CONNECT proxy so Java need not resolve `.localhost`.
 * TLS still terminates at the host gateway; normal hostname checks and the caller's pinned
 * [HttpsURLConnection.sslSocketFactory] remain intact. No trust-all factory is installed here.
 */
internal class IrohHttpsTransport(
    private val endpoint: IrohEndpointMetadata,
    private val openConnection: (URL, Proxy) -> java.net.URLConnection = { url, proxy -> url.openConnection(proxy) },
) : TransportEndpoint {
    override fun open(origin: GatewayOrigin, path: String): HttpsURLConnection {
        if (origin != endpoint.origin || !path.startsWith('/') || path.startsWith("//")
            || path.contains('\\') || path.contains('#') || path.any { it.code < 0x20 || it.code == 0x7f }) {
            throw IOException("Iroh HTTPS request is outside its paired origin")
        }
        val url = URL(origin.serialized + path)
        if (!GatewayUrlPolicy.isSameOrigin(origin, url.toString())) throw IOException("Iroh HTTPS request changed origin")
        val proxy = Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", endpoint.connectProxyPort))
        return openConnection(url, proxy) as? HttpsURLConnection
            ?: throw IOException("Iroh gateway transport is not HTTPS")
    }
}
