package io.github.sayach.dshmobileiroh

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Verifies status-bar glyph contrast for synchronized Web theme colors. */
class StatusBarChromeTest {
    @Test
    fun usesDarkIconsOnLightWebBackgrounds() {
        assertTrue(statusBarUsesDarkIcons(0xffffffff.toInt()))
        assertTrue(statusBarUsesDarkIcons(0xfff4f7fb.toInt()))
    }

    @Test
    fun usesLightIconsOnDarkWebBackgrounds() {
        assertFalse(statusBarUsesDarkIcons(0xff151517.toInt()))
        assertFalse(statusBarUsesDarkIcons(0xff000000.toInt()))
    }
}
