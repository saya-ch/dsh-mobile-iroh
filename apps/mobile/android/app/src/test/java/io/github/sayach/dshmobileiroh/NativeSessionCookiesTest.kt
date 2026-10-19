package io.github.sayach.dshmobileiroh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeSessionCookiesTest {
    private val session = NativeSession(
        origin = GatewayOrigin.parse("https://dsh.example.com")!!,
        instanceId = "a".repeat(64),
        deviceId = "b".repeat(32),
        deviceToken = null,
        deviceExpiresAt = null,
        sessionToken = "S".repeat(43),
        csrfToken = "C".repeat(43),
        sessionExpiresAt = 1_900_000_000_000L,
    )

    @Test
    fun replacesLegacyAndProtectedSessionAliasesWithTheSameCredentials() {
        val aliases = nativeSessionCookies(session)
        assertEquals(listOf("dsh_ma_session", "dsh_ma_csrf", "__Host-dsh_ma_session", "__Host-dsh_ma_csrf"), aliases.map { it.substringBefore('=') })
        assertEquals(aliases[0].substringAfter('='), aliases[2].substringAfter('='))
        assertEquals(aliases[1].substringAfter('='), aliases[3].substringAfter('='))
        assertTrue(aliases[0].startsWith("dsh_ma_session=${session.sessionToken};"))
        assertTrue(aliases[1].startsWith("dsh_ma_csrf=${session.csrfToken};"))
    }

    @Test
    fun keepsCredentialsSecureHostOnlyAndDoesNotInstallPersistentDeviceCredentials() {
        for (cookie in nativeSessionCookies(session)) {
            assertTrue(cookie.contains("; Path=/; Secure;"))
            assertTrue(cookie.endsWith("SameSite=Strict"))
            assertFalse(cookie.contains("Domain="))
            assertFalse(cookie.contains("dsh_ma_device"))
            assertEquals(cookie.substringBefore('=').endsWith("session"), cookie.contains("HttpOnly"))
        }
    }
}
