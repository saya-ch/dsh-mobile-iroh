package io.github.sayach.dshmobileiroh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/** Verifies that LAN and remote credentials retain distinct Keystore identities. */
class DeviceCredentialStoreTest {
    @Test
    fun remoteCredentialsUseTheirOwnPersistentKeyAlias() {
        val lan = deviceCredentialKeyAlias("lan")
        val remote = deviceCredentialKeyAlias("remote")

        assertEquals("dsh_mobile_device_v1", lan)
        assertEquals("dsh_mobile_device_v1_remote", remote)
        assertNotEquals(lan, remote)
    }
}
