package io.github.sayach.dshmobileiroh

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.w3c.dom.Element

/** Keeps only the configuration changes handled by the live WebView and native layouts. */
class WebViewConfigurationManifestTest {
    @Test
    fun resizingAndKeyboardChangesKeepTheActivityButThemeLanguageAndFontChangesDoNot() {
        val relativePaths = listOf(
            "src/main/AndroidManifest.xml",
            "app/src/main/AndroidManifest.xml",
            "apps/mobile/android/app/src/main/AndroidManifest.xml",
        )
        val workingDirectory = requireNotNull(System.getProperty("user.dir"))
        val manifest = generateSequence(File(workingDirectory)) { it.parentFile }
            .flatMap { directory -> relativePaths.asSequence().map { File(directory, it) } }
            .firstOrNull { it.isFile }
        assertNotNull("Android source manifest is missing", manifest)
        val factory = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
        val activities = factory.newDocumentBuilder().parse(manifest!!).getElementsByTagName("activity")
        val activity = (0 until activities.length).asSequence().map { activities.item(it) as Element }
            .first { it.getAttributeNS(ANDROID_NAMESPACE, "name") == ".MainActivity" }
        assertEquals(
            setOf("orientation", "screenSize", "smallestScreenSize", "screenLayout", "keyboard", "keyboardHidden"),
            activity.getAttributeNS(ANDROID_NAMESPACE, "configChanges").split('|').toSet(),
        )
        assertEquals("true", activity.getAttributeNS(ANDROID_NAMESPACE, "resizeableActivity"))
        assertEquals("adjustResize", activity.getAttributeNS(ANDROID_NAMESPACE, "windowSoftInputMode"))
    }

    private companion object {
        const val ANDROID_NAMESPACE = "http://schemas.android.com/apk/res/android"
    }
}
