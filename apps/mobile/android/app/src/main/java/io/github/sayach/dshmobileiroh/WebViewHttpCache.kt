package io.github.sayach.dshmobileiroh

import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/** Keeps revisioned DSH bundles below Chromium's per-entry cache limit on supported WebViews. */
internal const val MIN_WEBVIEW_HTTP_CACHE_QUOTA_BYTES = 64L * 1024 * 1024

internal fun desiredWebViewHttpCacheQuota(currentQuotaBytes: Long): Long =
    maxOf(currentQuotaBytes, MIN_WEBVIEW_HTTP_CACHE_QUOTA_BYTES)

/** Raises only this app's WebView profile quota; older WebViews retain their default cache policy. */
internal fun configureWebViewHttpCache(webView: WebView) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)
        || !WebViewFeature.isFeatureSupported(WebViewFeature.HTTP_CACHE_MANAGER)
    ) return
    val cache = WebViewCompat.getProfile(webView).httpCache
    val current = cache.quotaBytes
    val desired = desiredWebViewHttpCacheQuota(current)
    if (desired != current) cache.setQuotaBytes(desired)
}
