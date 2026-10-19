package io.github.sayach.dshmobileiroh

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Test
import org.w3c.dom.Element

/** A transferred encrypted database cannot be opened without the original device's Keystore. */
class DeviceTransferExclusionTest {
    @Test fun cloudBackupAndDeviceTransferExcludePairingsAndWebViewSessions() {
        val builder = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }.newDocumentBuilder()
        val manifest = builder.parse(sourceFile("AndroidManifest.xml"))
        val application = manifest.getElementsByTagName("application").item(0) as Element
        val namespace = "http://schemas.android.com/apk/res/android"
        assertEquals("false", application.getAttributeNS(namespace, "allowBackup"))
        assertEquals("false", application.getAttributeNS(namespace, "fullBackupContent"))
        assertEquals("@xml/data_extraction_rules", application.getAttributeNS(namespace, "dataExtractionRules"))

        val document = builder.parse(sourceFile("res/xml/data_extraction_rules.xml"))
        for (transport in listOf("cloud-backup", "device-transfer")) {
            val section = document.getElementsByTagName(transport).item(0) as Element
            val excludes = section.getElementsByTagName("exclude")
            val entries = (0 until excludes.length).map { excludes.item(it) as Element }
            assertEquals(setOf("root", "file", "database", "sharedpref", "external",
                "device_root", "device_file", "device_database", "device_sharedpref"),
                entries.map { it.getAttribute("domain") }.toSet())
            entries.forEach { assertEquals(".", it.getAttribute("path")) }
            assertEquals(0, section.getElementsByTagName("include").length)
        }
    }

    private fun sourceFile(path: String): File = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
        .flatMap { base -> listOf("src/main", "app/src/main", "apps/mobile/android/app/src/main").asSequence()
            .map { File(base, "$it/$path") } }
        .first { it.isFile }
}
