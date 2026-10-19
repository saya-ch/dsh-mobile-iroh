package io.github.sayach.dshmobileiroh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pins native injection scope; executable JavaScript checks run with the browser bundle. */
class WebViewCompatibilityShimTest {
    private val shim = BROWSER_COMPATIBILITY_SHIM

    @Test
    fun shimFillsOnlyApisThatAreAbsent() {
        assertTrue(shim.contains("typeof Promise.withResolvers !== 'function'"))
        assertEquals(1, Regex("Object\\.defineProperty\\(Promise, 'withResolvers'").findAll(shim).count())
        assertFalse(shim.contains("AbortSignal"))
    }

    @Test
    fun injectionMatchesOnlyThePairedOrigin() {
        listOf("https://desktop.example", "https://192.168.1.2:3443", "https://[::1]:3443").forEach { value ->
            val origin = requireNotNull(GatewayOrigin.parse(value))
            assertEquals(setOf(value), browserCompatibilityOrigins(origin))
            assertFalse(browserCompatibilityOrigins(origin).contains("*"))
        }
    }

    @Test
    fun shimStaysParseableByOlderEngines() {
        listOf("=>", "`", "let ", "const ", "?.", "??").forEach { syntax ->
            assertFalse("shim must not use $syntax", shim.contains(syntax))
        }
    }

    @Test
    fun shimCannotEscapeAnInlineScriptContext() {
        listOf("</script", "<!--", "-->").forEach { sequence ->
            assertFalse("shim must not contain $sequence", shim.contains(sequence))
        }
    }

    @Test
    fun shimKeepsInstallationFailureLocal() {
        assertTrue(shim.trimStart().startsWith("(function () {"))
        assertTrue(shim.trimEnd().endsWith("})();"))
        assertEquals(1, Regex("try \\{").findAll(shim).count())
        assertEquals(1, Regex("catch \\(").findAll(shim).count())
    }

    @Test
    fun shimAvoidsKotlinTemplateInterpolation() {
        assertFalse(shim.contains("$"))
    }
}
