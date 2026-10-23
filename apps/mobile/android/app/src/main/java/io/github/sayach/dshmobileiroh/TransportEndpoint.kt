package io.github.sayach.dshmobileiroh

import java.io.IOException
import java.net.URL
import javax.net.ssl.HttpsURLConnection

/**
 * Opens the HTTPS connection used by the Android gateway client.
 *
 * LAN and public HTTPS use [LocalTransport]. An authenticated native carrier uses
 * [IrohHttpsTransport] without changing hostname verification or the caller's CA pin.
 */
internal interface TransportEndpoint {
    /** Opens one request connection without starting network I/O. */
    fun open(origin: GatewayOrigin, path: String): HttpsURLConnection
}

/** The existing local HTTPS transport, kept as the default for all callers. */
internal object LocalTransport : TransportEndpoint {
    override fun open(origin: GatewayOrigin, path: String): HttpsURLConnection {
        if (IrohDeviceBinding.isIrohHost(origin.host)) throw IOException("Iroh requires its selected native transport")
        val connection = URL(origin.serialized + path).openConnection()
        return connection as? HttpsURLConnection
            ?: throw IOException("Gateway transport is not HTTPS")
    }
}
