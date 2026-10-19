package io.github.sayach.dshmobileiroh

import java.io.IOException
import java.net.URL
import javax.net.ssl.HttpsURLConnection

/**
 * Opens the HTTPS connection used by the Android gateway client.
 *
 * The baseline implementation deliberately remains URLConnection-backed. A
 * future native iroh adapter can be introduced at this seam once its
 * authenticated byte-stream protocol is available; this interface does not
 * claim that iroh is present or provide a synthetic iroh connection.
 */
internal interface TransportEndpoint {
    /** Opens one request connection without starting network I/O. */
    fun open(origin: GatewayOrigin, path: String): HttpsURLConnection
}

/** The existing local HTTPS transport, kept as the default for all callers. */
internal object LocalTransport : TransportEndpoint {
    override fun open(origin: GatewayOrigin, path: String): HttpsURLConnection {
        val connection = URL(origin.serialized + path).openConnection()
        return connection as? HttpsURLConnection
            ?: throw IOException("Gateway transport is not HTTPS")
    }
}
