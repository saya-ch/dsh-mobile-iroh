package io.github.sayach.dshmobileiroh

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Verifies provider detection for remote links and the Tailscale-only connectivity notice. */
class RemoteHostPolicyTest {
    private val contract: JSONObject by lazy {
        val resource = javaClass.classLoader?.getResource("url-policy-cases.json")
        assertNotNull("shared URL-policy contract is missing", resource)
        JSONObject(resource!!.readText())
    }

    /**
     * Runs the shared host vectors against the Android implementation. The remote
     * entry for a self-hosted frps is a bare public IPv4, so the contract keeps
     * every private, loopback, and documentation address out of that path.
     */
    @Test
    fun remoteHostCandidatesMatchSharedContract() {
        val cases = contract.getJSONArray("remoteHost")
        assertTrue("remote host vectors are missing", cases.length() > 0)
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index)
            val host = case.getString("host")
            assertEquals(
                case.getString("name"),
                case.getBoolean("allowedRemote"),
                RemoteHostPolicy.isAllowed(AccessMode.REMOTE, host),
            )
            assertEquals(
                case.getString("name"),
                case.getBoolean("allowedLan"),
                RemoteHostPolicy.isAllowed(AccessMode.LAN, host),
            )
        }
    }

    @Test
    fun recognizesSupportedRemoteProvidersCaseInsensitively() {
        assertTrue(RemoteHostPolicy.isSupported("computer.tail1234.ts.net"))
        assertTrue(RemoteHostPolicy.isSupported("EXAMPLE.CPOLAR.CN"))
        assertTrue(RemoteHostPolicy.isSupported("random-words-1234.trycloudflare.com"))
        assertTrue(RemoteHostPolicy.isSupported("RANDOM-WORDS-1234.TRYCLOUDFLARE.COM"))
        assertFalse(RemoteHostPolicy.isSupported("192.168.1.20"))
        assertFalse(RemoteHostPolicy.isSupported("tunnel.example.com"))
        assertFalse(RemoteHostPolicy.isSupported("trycloudflare.com.evil.test"))
        assertTrue(RemoteHostPolicy.isRemoteCandidate("dsh.example.com"))
        assertTrue(RemoteHostPolicy.isRemoteCandidate("1.2.3.4"))
        assertFalse(RemoteHostPolicy.isRemoteCandidate("192.168.1.20"))
        assertFalse(RemoteHostPolicy.isRemoteCandidate("10.0.0.8"))
        assertFalse(RemoteHostPolicy.isRemoteCandidate("100.64.0.8"))
        // Documentation TEST-NET addresses can never be a real VPS endpoint.
        assertFalse(RemoteHostPolicy.isRemoteCandidate("192.0.2.1"))
        assertFalse(RemoteHostPolicy.isRemoteCandidate("198.51.100.7"))
        assertFalse(RemoteHostPolicy.isRemoteCandidate("203.0.113.10"))
        assertFalse(RemoteHostPolicy.isRemoteCandidate("198.18.0.1"))
        assertFalse(RemoteHostPolicy.isRemoteCandidate("224.0.0.1"))
        assertFalse(RemoteHostPolicy.isRemoteCandidate("255.255.255.255"))
        assertFalse(RemoteHostPolicy.isRemoteCandidate("computer.local"))
    }

    @Test
    fun warnsOnlyForTailscale() {
        assertTrue(RemoteHostPolicy.needsTailscaleVpnNotice("computer.tail1234.ts.net"))
        assertFalse(RemoteHostPolicy.needsTailscaleVpnNotice("example.cpolar.cn"))
        assertFalse(RemoteHostPolicy.needsTailscaleVpnNotice("192.168.1.20"))
    }

    @Test
    fun identifiesOnlyCpolarProviderHosts() {
        assertTrue(RemoteHostPolicy.isCpolarHost("EXAMPLE.CPOLAR.CN"))
        assertTrue(RemoteHostPolicy.isCpolarHost("example.cpolar.io"))
        assertTrue(RemoteHostPolicy.isCpolarHost("example.cpolar.top"))
        assertTrue(RemoteHostPolicy.isCpolarHost("example.cpolar.com"))
        assertFalse(RemoteHostPolicy.isCpolarHost("computer.tail1234.ts.net"))
        assertFalse(RemoteHostPolicy.isCpolarHost("dsh.example.com"))
        assertFalse(RemoteHostPolicy.isCpolarHost("example.cpolar.cn.evil.test"))
    }

    @Test
    fun enforcesTheSelectedConnectionModeAtTheFinalOrigin() {
        assertTrue(RemoteHostPolicy.isAllowed(AccessMode.LAN, "192.168.1.20"))
        assertFalse(RemoteHostPolicy.isAllowed(AccessMode.LAN, "dsh-example.cpolar.cn"))
        assertTrue(RemoteHostPolicy.isAllowed(AccessMode.REMOTE, "dsh-example.cpolar.cn"))
        assertTrue(RemoteHostPolicy.isAllowed(AccessMode.REMOTE, "dsh.example.com"))
        assertTrue(RemoteHostPolicy.isAllowed(AccessMode.REMOTE, "1.2.3.4"))
        assertFalse(RemoteHostPolicy.isAllowed(AccessMode.LAN, "1.2.3.4"))
        assertFalse(RemoteHostPolicy.isAllowed(AccessMode.REMOTE, "203.0.113.10"))
        assertFalse(RemoteHostPolicy.isAllowed(AccessMode.REMOTE, "computer.local"))
        assertFalse(RemoteHostPolicy.isAllowed(AccessMode.LAN, "dsh.example.com"))
    }
}
