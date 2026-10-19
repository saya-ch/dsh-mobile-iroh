package io.github.sayach.dshmobileiroh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LanDiscoveryTest {
    @Test
    fun acceptsOnlyMetadataAnnouncementFromItsAdvertisedAddress() {
        val instanceId = "a".repeat(64)
        val result = LanDiscovery.parseAnnouncement(
            """{"deviceName":"Studio PC","origin":"https://192.168.1.20:3443","port":3443,"protocol":1,"instanceId":"$instanceId"}""",
            "192.168.1.20",
        )
        assertEquals(DiscoveredHarness("Studio PC", GatewayOrigin.parse("https://192.168.1.20:3443")!!, instanceId), result)
    }

    @Test
    fun rejectsSecretBearingOrAddressMismatchedAnnouncements() {
        val valid = """{"deviceName":"Studio PC","origin":"https://192.168.1.20:3443","port":3443,"protocol":1,"instanceId":"${"a".repeat(64)}"}"""
        val withSecret = valid.dropLast(1) + ",\"deviceToken\":\"secret\"}"
        assertNull(LanDiscovery.parseAnnouncement(withSecret, "192.168.1.20"))
        assertNull(LanDiscovery.parseAnnouncement(valid, "192.168.1.21"))
    }
}
