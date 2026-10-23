package io.github.sayach.dshmobileiroh

import java.io.IOException
import java.io.OutputStream
import java.net.URI

/** A foreground GET download that refuses cleartext and cross-origin redirects. */
internal object SameOriginDownloader {
    private const val MAX_REDIRECTS = 5

    /**
     * Streams one same-origin response to `output` through the pairing-key-pinned CA.
     */
    @Throws(IOException::class)
    fun download(
        origin: GatewayOrigin,
        initialUrl: String,
        userAgent: String?,
        cookieHeader: String?,
        caCertificate: ByteArray?,
        output: OutputStream,
        maxBytes: Long = MAX_DOWNLOAD_BYTES,
        transport: TransportEndpoint = LocalTransport,
    ) {
        if (IrohDeviceBinding.isIrohHost(origin.host) && transport === LocalTransport) {
            throw IOException("Iroh download requires its active paired transport")
        }
        var current = initialUrl
        repeat(MAX_REDIRECTS + 1) { redirectCount ->
            if (!GatewayUrlPolicy.isAllowedDownload(origin, current)) {
                throw IOException("Download left the configured origin")
            }
            val currentUri = URI(current)
            val connection = transport.open(origin, currentUri.rawPath.ifEmpty { "/" } + (currentUri.rawQuery?.let { "?$it" } ?: ""))
            try {
                if (caCertificate != null) connection.sslSocketFactory = PinnedTls.socketFactory(caCertificate)
                connection.instanceFollowRedirects = false
                connection.connectTimeout = 15_000
                connection.readTimeout = 60_000
                connection.useCaches = false
                connection.requestMethod = "GET"
                if (!userAgent.isNullOrBlank()) connection.setRequestProperty("User-Agent", userAgent)
                if (!cookieHeader.isNullOrBlank()) connection.setRequestProperty("Cookie", cookieHeader)

                val status = connection.responseCode
                if (status in 300..399) {
                    if (redirectCount == MAX_REDIRECTS) throw IOException("Too many redirects")
                    val location = connection.getHeaderField("Location")
                        ?: throw IOException("Redirect has no Location header")
                    current = URI(current).resolve(location).toString()
                    return@repeat
                }
                if (status !in 200..299) throw IOException("Download returned HTTP $status")
                if (connection.contentLengthLong > maxBytes) throw IOException("Download exceeds the mobile size limit")
                connection.inputStream.use { input -> copyDownloadAtMost(input, output, maxBytes) }
                return
            } finally {
                connection.disconnect()
            }
        }
        throw IOException("Download did not complete")
    }
}
