package io.github.sayach.dshmobileiroh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class VersionCompatibilityTest {
    @Test
    fun independentProductVersionUsesAnExplicitNativeApiBaseline() {
        val current = GatewayMetadata(1, "0.6.13", "0.6.5", 1)
        assertEquals(CompatibilityIssueKind.APP_TOO_OLD, VersionCompatibility.evaluate(BuildConfig.VERSION_NAME, current)?.kind)
        assertNull(VersionCompatibility.evaluate(BuildConfig.MOBILE_COMPATIBILITY_VERSION, current))
        assertEquals("0.6.5", BuildConfig.MOBILE_COMPATIBILITY_VERSION)
    }
    @Test
    fun acceptsTheCurrentAppAndPlugin() {
        assertNull(VersionCompatibility.evaluate("0.3.0", metadata()))
    }

    @Test
    fun requestsAnAppUpdateOnlyWhenTheGatewayRequiresIt() {
        val issue = VersionCompatibility.evaluate(
            "0.2.2",
            metadata(minimumApp = "0.3.0"),
        )

        assertEquals(CompatibilityIssueKind.APP_TOO_OLD, issue?.kind)
        assertEquals("0.3.0", issue?.requiredVersion)
    }

    @Test
    fun rejectsUnsupportedProtocolMetadata() {
        assertEquals(
            CompatibilityIssueKind.PROTOCOL_UNSUPPORTED,
            VersionCompatibility.evaluate("0.3.0", metadata(protocol = 2))?.kind,
        )
    }

    @Test
    fun rejectsMalformedVersionMetadataWithoutRequestingTheWrongUpdate() {
        val malformed = GatewayMetadata(1, "development", "latest", 1)

        assertEquals(
            CompatibilityIssueKind.PROTOCOL_UNSUPPORTED,
            VersionCompatibility.evaluate("0.3.0", malformed)?.kind,
        )
    }

    @Test
    fun comparesPrereleasesByTheirNumericRelease() {
        assertEquals(0, VersionCompatibility.compareVersions("0.3.0-alpha.1", "0.3.0"))
        assertEquals(-1, VersionCompatibility.compareVersions("0.2.9", "0.3.0"))
        assertEquals(1, VersionCompatibility.compareVersions("0.3.1", "0.3.0"))
    }

    private fun metadata(
        minimumApp: String = "0.2.2",
        protocol: Int = 1,
    ) = GatewayMetadata(
        version = 1,
        pluginVersion = "0.3.0",
        minimumAndroidAppVersion = minimumApp,
        discoveryProtocol = protocol,
    )
}
