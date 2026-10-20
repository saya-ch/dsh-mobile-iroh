package io.github.sayach.dshmobileiroh

import org.junit.Assert.assertFalse
import org.junit.Test

class IrohNativeTest {
    @Test
    fun baselineBuildDoesNotPretendTheOptionalLibraryIsPresent() {
        // The baseline APK intentionally does not package the Rust ABI yet.
        // This verifies the optional bridge reports that state without changing HTTPS defaults.
        assertFalse(IrohNative.loadIfAvailable())
    }
}
