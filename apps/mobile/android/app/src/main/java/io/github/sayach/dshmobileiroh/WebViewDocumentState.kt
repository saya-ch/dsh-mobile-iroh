package io.github.sayach.dshmobileiroh

import java.net.URI

/** Tracks whether the existing WebView still contains a successfully loaded DSH document. */
internal class WebViewDocumentState(private val origin: GatewayOrigin) {
    private var failed = false
    var generation: Int = 0
        private set
    var usable: Boolean = false
        private set

    fun started() {
        generation += 1
        usable = false
        failed = false
    }

    fun failed() {
        usable = false
        failed = true
    }

    fun finished(url: String, currentUrl: String): Boolean {
        val successful = !failed && isDshDocumentUrl(origin, url) && isDshDocumentUrl(origin, currentUrl)
        usable = successful
        return successful
    }

    /** Visible commits may start DOM inspection before nonessential resources have finished. */
    fun canInspectContent(url: String, currentUrl: String): Boolean = generation > 0 && !failed
        && isDshDocumentUrl(origin, url) && isDshDocumentUrl(origin, currentUrl)
        && sameMainDocumentUrl(origin, currentUrl, url)

    /** Only the current, nonfailed document can accept its asynchronous DOM readiness result. */
    fun confirmContentReady(expectedGeneration: Int): Boolean {
        if (generation == 0 || generation != expectedGeneration || failed) return false
        usable = true
        return true
    }

    /** A cancelled timer must not fail a newer document or already usable content. */
    fun shouldTimeout(expectedGeneration: Int): Boolean = generation > 0
        && generation == expectedGeneration && !failed && !usable
}

/** Only the root DSH shell is a page whose JavaScript state we may retain. */
internal fun isDshDocumentUrl(origin: GatewayOrigin, url: String): Boolean {
    if (!GatewayUrlPolicy.isSameOrigin(origin, url)) return false
    val path = runCatching { URI(url).path }.getOrNull() ?: return false
    return path == "/" || path.isEmpty()
}

/** Match a completed main-frame callback to the WebView's current page, including a normalized root slash. */
internal fun sameMainDocumentUrl(origin: GatewayOrigin, currentUrl: String, finishedUrl: String): Boolean {
    if (!GatewayUrlPolicy.isSameOrigin(origin, currentUrl)
        || !GatewayUrlPolicy.isSameOrigin(origin, finishedUrl)
    ) return false
    val current = runCatching { URI(currentUrl) }.getOrNull() ?: return false
    val finished = runCatching { URI(finishedUrl) }.getOrNull() ?: return false
    return current.rawPath.orEmpty().ifEmpty { "/" } == finished.rawPath.orEmpty().ifEmpty { "/" }
        && current.rawQuery == finished.rawQuery
}

/** Ignore stale renewals; keep a live document, or rebuild an invalid one. */
internal enum class RenewedDocumentAction { IGNORE, KEEP, RELOAD }

/** The WebView JavaScript result is true only after the dedicated React shell mounts. */
internal const val MOUNTED_DSH_PROBE = "document.querySelector('.dshm-shell') !== null"
/** Usable page controls release the native loading surface without waiting for background resources. */
internal val INITIAL_DSH_READY_PROBE = """
    (() => {
        if (!document.body) return false;
        const root = document.body;
        const visible = element => {
            if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
            const style = getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
            for (let parent = element; parent; parent = parent.parentElement) {
                if (getComputedStyle(parent).opacity === '0') return false;
            }
            const box = element.getBoundingClientRect();
            return box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0
                && box.left < innerWidth && box.top < innerHeight;
        };
        if ([...document.querySelectorAll('[data-dsh-boot]')].some(visible)) return false;
        return [...root.querySelectorAll('button, a[href], input:not([type="hidden"]), textarea, [contenteditable="true"], [role="button"], [role="textbox"]')]
            .some(element => {
                if (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true'
                    || element.closest('[aria-disabled="true"]') || getComputedStyle(element).pointerEvents === 'none' || !visible(element)) return false;
                const box = element.getBoundingClientRect();
                const hit = document.elementFromPoint((Math.max(0, box.left) + Math.min(innerWidth, box.right)) / 2,
                    (Math.max(0, box.top) + Math.min(innerHeight, box.bottom)) / 2);
                return hit !== null && (hit === element || element.contains(hit));
            });
    })()
""".trimIndent()
internal fun mountedDshProbeResult(result: String?): Boolean = result == "true"

/** Ask the current page to close one mobile-owned layer before native navigation. */
internal const val MOBILE_BACK_SCRIPT = "(() => { const event = new Event('dsh-mobile:native-back', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented })()"
internal enum class MobileBackEvaluation { CONSUMED, UNHANDLED, UNAVAILABLE }
internal fun mobileBackEvaluation(result: String?): MobileBackEvaluation = when (result) {
    "true" -> MobileBackEvaluation.CONSUMED
    "false" -> MobileBackEvaluation.UNHANDLED
    else -> MobileBackEvaluation.UNAVAILABLE
}

internal enum class MobileBackAction { IGNORE, PAGE_HANDLED, NATIVE_BACK, RETRY }

/** A late page response cannot navigate a replacement WebView or document. */
internal fun mobileBackAction(
    expectedGeneration: Int,
    currentGeneration: Int,
    sameWebView: Boolean,
    sameDocument: Boolean,
    activityActive: Boolean,
    evaluation: MobileBackEvaluation,
): MobileBackAction = when {
    expectedGeneration != currentGeneration || !sameWebView || !sameDocument || !activityActive -> MobileBackAction.IGNORE
    evaluation == MobileBackEvaluation.CONSUMED -> MobileBackAction.PAGE_HANDLED
    evaluation == MobileBackEvaluation.UNHANDLED -> MobileBackAction.NATIVE_BACK
    else -> MobileBackAction.RETRY
}

internal fun renewedDocumentAction(
    expectedGeneration: Int,
    currentGeneration: Int,
    sameWebView: Boolean,
    sameOrigin: Boolean,
    mounted: Boolean,
): RenewedDocumentAction = when {
    expectedGeneration != currentGeneration || !sameWebView -> RenewedDocumentAction.IGNORE
    !sameOrigin -> RenewedDocumentAction.RELOAD
    mounted -> RenewedDocumentAction.KEEP
    else -> RenewedDocumentAction.RELOAD
}

/** An exhausted retry keeps only a mounted page; stale callbacks cannot change screens. */
internal enum class ExhaustedRecoveryAction { IGNORE, KEEP_PAGE, SHOW_CONNECTIONS }

internal fun exhaustedRecoveryAction(
    expectedGeneration: Int,
    currentGeneration: Int,
    sameWebView: Boolean,
    mounted: Boolean,
): ExhaustedRecoveryAction = when {
    expectedGeneration != currentGeneration || !sameWebView -> ExhaustedRecoveryAction.IGNORE
    mounted -> ExhaustedRecoveryAction.KEEP_PAGE
    else -> ExhaustedRecoveryAction.SHOW_CONNECTIONS
}
