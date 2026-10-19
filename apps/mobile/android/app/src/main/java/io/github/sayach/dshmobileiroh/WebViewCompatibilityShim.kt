package io.github.sayach.dshmobileiroh

import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * Install an early Promise fallback for the paired origin's inline boot script.
 * The dedicated frontend's bundled compatibility script supplies Iterator helpers,
 * Promise.withResolvers and AbortSignal.any even without document-start support.
 *
 * @param webView the browser being prepared for the gateway origin.
 * @param origin the exact HTTPS origin approved during pairing.
 * @return whether the shim was installed; false when the WebView lacks the feature.
 */
internal fun installBrowserCompatibilityShim(webView: WebView, origin: GatewayOrigin): Boolean {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return false
    return runCatching {
        WebViewCompat.addDocumentStartJavaScript(webView, BROWSER_COMPATIBILITY_SHIM, browserCompatibilityOrigins(origin))
        true
    }.getOrDefault(false)
}

/** Exact matching rules shared with document-start injection tests. */
internal fun browserCompatibilityOrigins(origin: GatewayOrigin): Set<String> = setOf(origin.serialized)

/**
 * ES5-only source for the document-start shim.
 *
 * The gateway bundle owns broader compatibility; this fallback only supplies the
 * Promise capability required by inline boot readiness before a bundle is loaded.
 */
internal const val BROWSER_COMPATIBILITY_SHIM = """
(function () {
  'use strict';
  try {
    if (typeof Promise.withResolvers !== 'function') {
      Object.defineProperty(Promise, 'withResolvers', {
        configurable: true,
        writable: true,
        value: function withResolvers() {
          var resolve, reject;
          var promise = new this(function (res, rej) {
            if (resolve !== undefined || reject !== undefined) throw new TypeError('Promise capability already initialized');
            resolve = res;
            reject = rej;
          });
          if (typeof resolve !== 'function' || typeof reject !== 'function') throw new TypeError('Invalid Promise capability');
          return { promise: promise, resolve: resolve, reject: reject };
        }
      });
    }
  } catch (error) { /* A non-extensible Promise constructor cannot receive this optional fallback. */ }
})();
"""
