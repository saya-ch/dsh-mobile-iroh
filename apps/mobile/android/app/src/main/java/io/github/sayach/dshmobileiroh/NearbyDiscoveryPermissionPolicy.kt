package io.github.sayach.dshmobileiroh

/** Keeps LAN fallbacks usable when Android 13+ nearby-device access is declined. */
internal object NearbyDiscoveryPermissionPolicy {
    fun shouldRequest(apiLevel: Int, granted: Boolean, previouslyDeclined: Boolean): Boolean =
        apiLevel >= 33 && !granted && !previouslyDeclined
}
