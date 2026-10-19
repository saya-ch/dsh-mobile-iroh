package io.github.sayach.dshmobileiroh

import java.io.File
import kotlin.math.pow
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/** Measures the semantic foreground/background pair used by native primary buttons. */
class ThemeContrastTest {
    @Test fun primaryButtonLabelsMeetNormalTextContrastInBothThemes() {
        for (theme in listOf("values", "values-night")) {
            val document = DocumentBuilderFactory.newInstance().newDocumentBuilder()
                .parse(sourceFile("res/$theme/colors.xml"))
            val nodes = document.getElementsByTagName("color")
            val colors = (0 until nodes.length).map { nodes.item(it) as Element }
                .associate { it.getAttribute("name") to it.textContent.trim() }
            val foreground = luminance(colors.getValue("app_on_accent"))
            val background = luminance(colors.getValue("app_accent"))
            val contrast = (maxOf(foreground, background) + 0.05) / (minOf(foreground, background) + 0.05)
            assertTrue("$theme primary label contrast $contrast must be at least 4.5:1", contrast >= 4.5)
        }
    }

    private fun luminance(color: String): Double {
        val rgb = color.removePrefix("#").toLong(16)
        fun channel(shift: Int): Double {
            val value = ((rgb shr shift) and 255).toDouble() / 255
            return if (value <= 0.04045) value / 12.92 else ((value + 0.055) / 1.055).pow(2.4)
        }
        return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
    }

    private fun sourceFile(path: String): File = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
        .flatMap { base -> listOf("src/main", "app/src/main", "apps/mobile/android/app/src/main").asSequence()
            .map { File(base, "$it/$path") } }
        .first { it.isFile }
}
