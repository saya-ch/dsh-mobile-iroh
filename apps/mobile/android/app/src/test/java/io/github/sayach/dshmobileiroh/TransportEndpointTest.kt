package io.github.sayach.dshmobileiroh

import java.io.ByteArrayInputStream
import java.io.OutputStream
import java.net.URL
import java.security.cert.Certificate
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.HttpsURLConnection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class TransportEndpointTest {
    private val origin = GatewayOrigin.parse("https://example.com")!!

    @Test
    fun localTransportKeepsTheExistingHttpsUrlConstruction() {
        val connection = LocalTransport.open(origin, "/mobile-access/discovery")

        assertEquals("https://example.com/mobile-access/discovery", connection.url.toString())
        connection.disconnect()
    }

    @Test
    fun nativeAuthClientCanUseAnInjectedEndpointWithoutChangingTheDefault() {
        val connection = TestConnection(
            URL("https://example.com/mobile-access/discovery"),
            "{\"version\":1}".toByteArray(),
        )
        val endpoint = object : TransportEndpoint {
            override fun open(requestOrigin: GatewayOrigin, path: String): HttpsURLConnection {
                assertSame(origin, requestOrigin)
                assertEquals("/mobile-access/discovery", path)
                return connection
            }
        }

        assertEquals(1, NativeAuthClient.fetchDiscovery(origin, transport = endpoint).getInt("version"))
        assertEquals(1, connection.disconnections.get())
    }

    private class TestConnection(
        url: URL,
        private val body: ByteArray,
    ) : HttpsURLConnection(url) {
        val disconnections = AtomicInteger()

        override fun connect() = Unit
        override fun disconnect() { disconnections.incrementAndGet() }
        override fun usingProxy(): Boolean = false
        override fun getCipherSuite(): String = "test"
        override fun getLocalCertificates(): Array<Certificate>? = null
        override fun getServerCertificates(): Array<Certificate> = emptyArray()
        override fun getResponseCode(): Int = HTTP_OK
        override fun getContentType(): String = "application/json"
        override fun getInputStream() = ByteArrayInputStream(body)
        override fun getOutputStream(): OutputStream = OutputStream.nullOutputStream()
    }
}
