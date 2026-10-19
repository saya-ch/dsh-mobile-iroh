package io.github.sayach.dshmobileiroh

internal data class GatewayMetadata(
    val version: Int,
    val pluginVersion: String,
    val minimumAndroidAppVersion: String,
    val discoveryProtocol: Int,
)

internal enum class CompatibilityIssueKind {
    APP_TOO_OLD,
    PLUGIN_TOO_OLD,
    PROTOCOL_UNSUPPORTED,
}

internal data class CompatibilityIssue(
    val kind: CompatibilityIssueKind,
    val requiredVersion: String? = null,
)

/** Compares public gateway metadata without making unavailable legacy metadata fatal. */
internal object VersionCompatibility {
    private const val MINIMUM_PLUGIN_VERSION = "0.2.2"
    private const val METADATA_VERSION = 1
    private const val DISCOVERY_PROTOCOL = 1

    fun evaluate(appVersion: String, metadata: GatewayMetadata): CompatibilityIssue? {
        if (metadata.version != METADATA_VERSION || metadata.discoveryProtocol != DISCOVERY_PROTOCOL) {
            return CompatibilityIssue(CompatibilityIssueKind.PROTOCOL_UNSUPPORTED)
        }
        if (parse(appVersion) == null
            || parse(metadata.pluginVersion) == null
            || parse(metadata.minimumAndroidAppVersion) == null) {
            return CompatibilityIssue(CompatibilityIssueKind.PROTOCOL_UNSUPPORTED)
        }
        if (compareVersions(appVersion, metadata.minimumAndroidAppVersion) < 0) {
            return CompatibilityIssue(CompatibilityIssueKind.APP_TOO_OLD, metadata.minimumAndroidAppVersion)
        }
        if (compareVersions(metadata.pluginVersion, MINIMUM_PLUGIN_VERSION) < 0) {
            return CompatibilityIssue(CompatibilityIssueKind.PLUGIN_TOO_OLD, MINIMUM_PLUGIN_VERSION)
        }
        return null
    }

    internal fun compareVersions(left: String, right: String): Int {
        val leftParts = parse(left) ?: return -1
        val rightParts = parse(right) ?: return 1
        for (index in leftParts.indices) {
            val compared = leftParts[index].compareTo(rightParts[index])
            if (compared != 0) return compared
        }
        return 0
    }

    private fun parse(value: String): List<Int>? {
        val match = VERSION.matchEntire(value.trim()) ?: return null
        return (1..3).map { match.groupValues[it].toIntOrNull() ?: return null }
    }

    private val VERSION = Regex("^(\\d+)\\.(\\d+)\\.(\\d+)(?:[-+].*)?$")
}
