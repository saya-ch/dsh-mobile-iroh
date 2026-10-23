package io.github.sayach.dshmobileiroh

import java.io.IOException
import java.net.InetSocketAddress
import java.net.Proxy
import javax.net.ssl.HttpsURLConnection
import org.junit.Assert.*
import org.junit.Test

class IrohHttpsTransportTest {
    private val peer = "a".repeat(64)
    private val metadata = "{\"version\":1,\"peerId\":\"$peer\",\"localPort\":25443,\"connectProxyPort\":30201}"

    @Test
    fun metadataBindsExactFullPeerAndVersionedBoundedPorts() {
        val endpoint = IrohEndpointMetadata.parse(metadata, peer)
        assertEquals("https://${"a".repeat(32)}.${"a".repeat(32)}.iroh.localhost:25443", endpoint.origin.serialized)
        for (invalid in listOf(
            metadata.replace("\"version\":1", "\"version\":2"),
            metadata.replace("\"version\":1", "\"version\":1,\"unexpected\":true"),
            metadata.replace("30201", "25443"),
            metadata.replace("30201", "0"),
            metadata.replace("30201", "65536"),
            metadata.replace("30201", "\"30201\""),
            metadata.replace("30201", "30201.5"),
            metadata.replace(peer, "b".repeat(64)),
            metadata + " ".repeat(2048),
        )) assertThrows(IOException::class.java) { IrohEndpointMetadata.parse(invalid, peer) }
    }

    @Test
    fun proxyTargetsOnlyLoopbackWhileHttpsUrlAndTlsChecksRemainPaired() {
        val endpoint = IrohEndpointMetadata.parse(metadata, peer)
        var captured = false
        val transport = IrohHttpsTransport(endpoint) { url, proxy ->
            assertEquals(endpoint.origin.serialized + "/mobile-access/auth/native-renew", url.toString())
            assertEquals(Proxy.Type.HTTP, proxy.type())
            val address = proxy.address() as InetSocketAddress
            assertEquals("127.0.0.1", address.address.hostAddress)
            assertEquals(30201, address.port)
            captured = true
            url.openConnection(proxy)
        }
        val connection = transport.open(endpoint.origin, "/mobile-access/auth/native-renew")
        assertTrue(captured)
        assertEquals("https", connection.url.protocol)
        assertSame(HttpsURLConnection.getDefaultHostnameVerifier(), connection.hostnameVerifier)
        assertSame(HttpsURLConnection.getDefaultSSLSocketFactory(), connection.sslSocketFactory)
        connection.disconnect()
    }

    @Test
    fun wrongPeerOriginOrAmbiguousPathNeverOpensProxy() {
        val endpoint = IrohEndpointMetadata.parse(metadata, peer)
        val transport = IrohHttpsTransport(endpoint) { _, _ -> fail("unsafe request reached opener"); throw AssertionError() }
        assertThrows(IOException::class.java) { transport.open(GatewayOrigin.parse("https://example.com")!!, "/") }
        for (path in listOf("//example.com/x", "relative", "/x\\y", "/x#fragment", "/x\r\nInjected: yes")) {
            assertThrows(IOException::class.java) { transport.open(endpoint.origin, path) }
        }
    }

    @Test
    fun nativeAuthenticationAndDownloadsCannotFallBackToLocalDnsWithoutCarrier() {
        val origin = IrohEndpointMetadata.parse(metadata, peer).origin
        val failure = assertThrows(NativeAuthFailure::class.java) {
            NativeAuthClient.renew(origin, "T".repeat(43), TestCertificates.ingressCa, TestCertificates.instanceIdOf(TestCertificates.ingressCa))
        }
        assertEquals(NativeAuthFailureKind.NETWORK, failure.kind)
        assertThrows(IOException::class.java) {
            SameOriginDownloader.download(origin, origin.serialized + "/file.txt", null, null,
                TestCertificates.ingressCa, java.io.ByteArrayOutputStream())
        }
    }
}
