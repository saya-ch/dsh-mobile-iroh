package io.github.sayach.dshmobileiroh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebViewDocumentStateTest {
    private val origin = GatewayOrigin.parse("https://dsh.example.com")!!

    @Test
    fun aSuccessfullyLoadedDshDocumentMayBeMarkedLive() {
        val document = WebViewDocumentState(origin)
        document.started()

        assertTrue(document.finished("https://dsh.example.com/", "https://dsh.example.com/"))
        assertTrue(document.usable)
    }

    @Test
    fun aFailedMainFrameIsNotMarkedLiveByPageFinished() {
        val document = WebViewDocumentState(origin)
        document.started()
        document.failed()

        assertFalse(document.finished("https://dsh.example.com/", "https://dsh.example.com/"))
        assertFalse(document.usable)
    }

    @Test
    fun aVisibleRootCanBeInspectedBeforePageFinishedButDoesNotBecomeUsableOnCommitAlone() {
        val document = WebViewDocumentState(origin)
        assertFalse(document.canInspectContent("https://dsh.example.com/", "https://dsh.example.com/"))
        assertFalse(document.confirmContentReady(document.generation))
        document.started()

        assertTrue(document.canInspectContent("https://dsh.example.com", "https://dsh.example.com/"))
        assertFalse(document.usable)
        assertTrue(document.shouldTimeout(document.generation))
        assertTrue(document.confirmContentReady(document.generation))
        assertTrue(document.usable)
        assertFalse(document.shouldTimeout(document.generation))
    }

    @Test
    fun failedMainFramesCannotStartOrAcceptDomReadinessChecks() {
        val document = WebViewDocumentState(origin)
        document.started()
        val generation = document.generation
        document.failed()

        assertFalse(document.canInspectContent("https://dsh.example.com/", "https://dsh.example.com/"))
        assertFalse(document.confirmContentReady(generation))
        assertFalse(document.shouldTimeout(generation))
        assertFalse(document.usable)
    }

    @Test
    fun visibleLoginBlankAndUnrelatedRootCallbacksCannotStartTheReadyProbe() {
        val document = WebViewDocumentState(origin)
        document.started()
        for (url in listOf(
            "about:blank",
            "https://dsh.example.com/mobile-access/login",
            "https://dsh.example.com/mobile-access/pair",
            "https://other.example.com/",
            "https://dsh.example.com:3443/",
        )) {
            assertFalse(document.canInspectContent(url, url))
            assertFalse(document.canInspectContent(url, "https://dsh.example.com/"))
            assertFalse(document.canInspectContent("https://dsh.example.com/", url))
        }
        assertFalse(document.canInspectContent("https://dsh.example.com/?a=1", "https://dsh.example.com/?a=2"))
        assertTrue(document.canInspectContent("https://dsh.example.com/?a=1#old", "https://dsh.example.com/?a=1#new"))
    }

    @Test
    fun aLateReadyResultAndTimerCannotActOnANewerNavigationEvenAtTheSameUrl() {
        val document = WebViewDocumentState(origin)
        document.started()
        val previous = document.generation
        document.started()
        val current = document.generation

        assertEquals(previous + 1, current)
        assertFalse(document.confirmContentReady(previous))
        assertFalse(document.shouldTimeout(previous))
        assertFalse(document.usable)
        assertTrue(document.shouldTimeout(current))
        assertTrue(document.confirmContentReady(current))
        assertTrue(document.usable)
        assertFalse(document.shouldTimeout(current))
    }

    @Test
    fun anotherNavigationRestoresTheDeadlineAfterConfirmedUsableContent() {
        val document = WebViewDocumentState(origin)
        document.started()
        assertTrue(document.confirmContentReady(document.generation))
        document.started()

        assertFalse(document.usable)
        assertTrue(document.shouldTimeout(document.generation))
        document.failed()
        assertFalse(document.confirmContentReady(document.generation))
    }

    @Test
    fun aNewNavigationInvalidatesThePreviousDocumentUntilItFinishes() {
        val document = WebViewDocumentState(origin)
        document.started()
        assertTrue(document.finished("https://dsh.example.com/", "https://dsh.example.com/"))

        document.started()
        assertFalse(document.usable)
        assertFalse(document.finished("https://dsh.example.com/", "https://dsh.example.com/mobile-access/login"))
        assertTrue(document.finished("https://dsh.example.com/?view=other", "https://dsh.example.com/?view=other"))
    }

    @Test
    fun loginAndPairingDocumentsNeverCountAsTheDshPage() {
        val document = WebViewDocumentState(origin)
        val login = "https://dsh.example.com/mobile-access/login?return=%2F"
        document.started()
        assertFalse(document.finished(login, login))
        assertFalse(isDshDocumentUrl(origin, login))
        assertFalse(isDshDocumentUrl(origin, "https://dsh.example.com/mobile-access/pair"))
        assertFalse(isDshDocumentUrl(origin, "https://other.example.com/"))
        assertFalse(isDshDocumentUrl(origin, "https://dsh.example.com/api/remote.mux"))
        assertFalse(isDshDocumentUrl(origin, "https://dsh.example.com/plugins/events"))
        assertFalse(isDshDocumentUrl(origin, "https://dsh.example.com/sidebar/file"))
        assertTrue(isDshDocumentUrl(origin, "https://dsh.example.com/"))
    }

    @Test
    fun aSurvivingPageIsKeptAfterCookieRenewal() {
        assertTrue(mountedDshProbeResult("true"))
        assertTrue(renewedDocumentAction(4, 4, true, true, true) == RenewedDocumentAction.KEEP)
    }

    @Test
    fun onlyAnExplicitPageBackConsumptionStopsNativeNavigation() {
        assertTrue(MOBILE_BACK_SCRIPT.contains("dsh-mobile:native-back"))
        assertTrue(MOBILE_BACK_SCRIPT.contains("cancelable: true"))
        assertTrue(mobileBackEvaluation("true") == MobileBackEvaluation.CONSUMED)
        assertTrue(mobileBackEvaluation("false") == MobileBackEvaluation.UNHANDLED)
        assertTrue(mobileBackEvaluation("null") == MobileBackEvaluation.UNAVAILABLE)
        assertTrue(mobileBackEvaluation(null) == MobileBackEvaluation.UNAVAILABLE)
        assertTrue(mobileBackAction(4, 4, true, true, true, MobileBackEvaluation.CONSUMED) == MobileBackAction.PAGE_HANDLED)
        assertTrue(mobileBackAction(4, 4, true, true, true, MobileBackEvaluation.UNHANDLED) == MobileBackAction.NATIVE_BACK)
        assertTrue(mobileBackAction(4, 4, true, true, true, MobileBackEvaluation.UNAVAILABLE) == MobileBackAction.RETRY)
        assertTrue(mobileBackAction(4, 5, true, true, true, MobileBackEvaluation.UNHANDLED) == MobileBackAction.IGNORE)
        assertTrue(mobileBackAction(4, 4, false, true, true, MobileBackEvaluation.UNHANDLED) == MobileBackAction.IGNORE)
        assertTrue(mobileBackAction(4, 4, true, false, true, MobileBackEvaluation.UNHANDLED) == MobileBackAction.IGNORE)
        assertTrue(mobileBackAction(4, 4, true, true, false, MobileBackEvaluation.UNHANDLED) == MobileBackAction.IGNORE)
    }

    @Test
    fun aFailedPageOrRendererIsReloadedAfterCookieRenewal() {
        assertFalse(mountedDshProbeResult("false"))
        assertFalse(mountedDshProbeResult(null))
        assertTrue(renewedDocumentAction(4, 4, true, true, false) == RenewedDocumentAction.RELOAD)
    }

    @Test
    fun aLateProbeCannotReplaceAnotherDeviceOrWebView() {
        assertTrue(renewedDocumentAction(4, 5, true, true, false) == RenewedDocumentAction.IGNORE)
        assertTrue(renewedDocumentAction(4, 4, false, true, false) == RenewedDocumentAction.IGNORE)
        assertTrue(renewedDocumentAction(4, 4, true, false, false) == RenewedDocumentAction.RELOAD)
    }

    @Test
    fun completedHtmlWithFailedApplicationScriptCannotBePreservedOrLeftBlank() {
        val document = WebViewDocumentState(origin)
        document.started()
        assertTrue(document.finished("https://dsh.example.com/", "https://dsh.example.com/"))
        assertTrue(MOUNTED_DSH_PROBE.contains(".dshm-shell"))
        val mounted = mountedDshProbeResult("false")

        assertTrue(renewedDocumentAction(4, 4, true, true, mounted) == RenewedDocumentAction.RELOAD)
        assertTrue(exhaustedRecoveryAction(4, 4, true, mounted) == ExhaustedRecoveryAction.SHOW_CONNECTIONS)
    }

    @Test
    fun mountedPageKeepsRetryDialogButRendererLossMakesOldCallbacksInert() {
        assertTrue(exhaustedRecoveryAction(4, 4, true, true) == ExhaustedRecoveryAction.KEEP_PAGE)
        assertTrue(renewedDocumentAction(4, 5, false, true, true) == RenewedDocumentAction.IGNORE)
        assertTrue(exhaustedRecoveryAction(4, 5, false, false) == ExhaustedRecoveryAction.IGNORE)
    }

    @Test
    fun successfulRootCompletionCancelsTheTimeoutAfterUrlNormalization() {
        assertTrue(sameMainDocumentUrl(origin, "https://dsh.example.com/", "https://dsh.example.com"))
        assertTrue(sameMainDocumentUrl(origin, "https://dsh.example.com/?frontend=dedicated", "https://dsh.example.com/?frontend=dedicated"))
        assertFalse(sameMainDocumentUrl(origin, "https://dsh.example.com/", "https://dsh.example.com/mobile-access/login"))
        assertFalse(sameMainDocumentUrl(origin, "https://dsh.example.com/?a=1", "https://dsh.example.com/?a=2"))
        assertFalse(sameMainDocumentUrl(origin, "https://other.example.com/", "https://dsh.example.com/"))
    }
}
