package io.github.sayach.dshmobileiroh

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/** Runs the language-neutral origin-policy vectors against the Android implementation. */
class GatewayUrlPolicyContractTest {
    private val contract: JSONObject by lazy {
        val resource = javaClass.classLoader?.getResource("url-policy-cases.json")
        assertNotNull("shared URL-policy contract is missing", resource)
        JSONObject(resource!!.readText())
    }

    @Test
    fun normalizationMatchesSharedContract() {
        val cases = contract.getJSONArray("normalization")
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index)
            val expected = if (case.isNull("expected")) null else case.getString("expected")
            assertEquals(case.getString("name"), expected, GatewayUrlPolicy.normalizeOrigin(case.getString("input")))
        }
    }

    @Test
    fun connectionTargetsMatchSharedContract() {
        val cases = contract.getJSONArray("connections")
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index)
            val expected = case.optJSONObject("expected")
            val actual = GatewayConnection.parse(case.getString("input"))
            assertEquals(case.getString("name"), expected?.getString("origin"), actual?.origin?.serialized)
            assertEquals(case.getString("name"), expected?.getString("initialURL"), actual?.initialUrl)
        }
    }

    @Test
    fun sameOriginMatchesSharedContract() {
        val cases = contract.getJSONArray("sameOrigin")
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index)
            val origin = GatewayOrigin.parse(case.getString("base"))
            assertNotNull(case.getString("name"), origin)
            assertEquals(
                case.getString("name"),
                case.getBoolean("expected"),
                GatewayUrlPolicy.isSameOrigin(origin!!, case.getString("candidate")),
            )
        }
    }

    @Test
    fun downloadsMatchSharedContract() {
        val cases = contract.getJSONArray("downloads")
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index)
            val origin = GatewayOrigin.parse(case.getString("base"))
            assertNotNull(case.getString("name"), origin)
            assertEquals(
                case.getString("name"),
                case.getBoolean("expected"),
                GatewayUrlPolicy.isAllowedDownload(origin!!, case.getString("candidate")),
            )
        }
    }

    @Test
    fun pairingKeyRequiresTheFingerprintBoundLink() {
        val instanceId = "a".repeat(64)
        val token = "A".repeat(43)
        assertEquals(
            PairingKey(instanceId, token),
            GatewayUrlPolicy.pairingKey("https://192.168.1.20:3443/mobile-access/pair#instance=$instanceId&token=$token"),
        )
        assertEquals(
            PairingKey(instanceId, token, requiresCa = true),
            GatewayUrlPolicy.pairingKey("https://1.2.3.4:33080/mobile-access/pair#key=dsh2.$instanceId.$token"),
        )

        // A bare pairing key is not a link.
        assertNull(GatewayUrlPolicy.pairingKey("dsh1.$instanceId.${"B".repeat(43)}"))

        // Legacy token-only links do not authenticate the certificate fingerprint.
        assertNull(GatewayUrlPolicy.pairingKey("https://192.168.1.20:3443/mobile-access/pair#token=$token"))
        assertNull(GatewayUrlPolicy.pairingKey("https://1.2.3.4:33080/mobile-access/pair#key=dsh1.$instanceId.$token"))

        // The fixed pairing page without a fragment carries no key.
        assertNull(GatewayUrlPolicy.pairingKey("https://192.168.1.20:3443/mobile-access/pair"))

        // Any path other than the fixed pairing page is rejected.
        assertNull(GatewayUrlPolicy.pairingKey("https://192.168.1.20:3443/other#instance=$instanceId&token=${"D".repeat(43)}"))
    }
}
