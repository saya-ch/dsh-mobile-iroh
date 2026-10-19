package io.github.sayach.dshmobileiroh

import org.junit.Assert.assertEquals
import org.junit.Test

class WebViewHttpCacheTest {
    @Test fun raisesSmallDefaultQuotaForLargeBundles() {
        assertEquals(64L * 1024 * 1024, desiredWebViewHttpCacheQuota(20L * 1024 * 1024))
    }

    @Test fun preservesAlreadyLargerQuota() {
        assertEquals(128L * 1024 * 1024, desiredWebViewHttpCacheQuota(128L * 1024 * 1024))
    }
}
