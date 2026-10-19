package io.github.sayach.dshmobileiroh

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Keep the pure selection owner wired to the actual standard WebView path. */
class WebFileChooserWiringTest {
    @Test fun standardPickerReceivesBrowserIdentityAndCancelsOnNavigationAndDestruction() {
        val source = activitySource()
        assertTrue(source.contains("showFileChooser(webView, origin, filePathCallback, fileChooserParams)"))
        val browser = methodBody(source, "showBrowser")
        val navigation = browser.substringAfter("onTopLevelUrlChanged =").substringBefore("onLoaded =")
        assertTrue(navigation.contains("invalidateWebFileChooser()"))
        val teardown = methodBody(source, "destroyWebView")
        assertTrue(teardown.indexOf("invalidateWebFileChooser()") < teardown.indexOf("destroy()"))
        assertFalse(source.contains("uploadCallback"))
        assertTrue(source.contains("outState.putInt(STATE_NEXT_FILE_CHOOSER_CODE, webFileChooserRequestCodes.nextCode())"))
        assertTrue(source.contains("let(webFileChooserRequestCodes::restoreAtLeast)"))
    }

    @Test fun directPhotoAndDocumentLaunchKeepFiltersAndMultipleWithoutAnExtraChooser() {
        val source = activitySource()
        val selector = methodBody(source, "showFileChooser")
        assertTrue(selector.contains("MediaStore.ACTION_PICK_IMAGES"))
        assertTrue(selector.contains("MediaStore.EXTRA_PICK_IMAGES_MAX"))
        assertTrue(selector.contains("MediaStore.getPickImagesMaxLimit()"))
        assertTrue(selector.contains("params.isCaptureEnabled"))
        assertTrue(selector.contains("Intent.ACTION_OPEN_DOCUMENT"))
        assertTrue(selector.contains("Intent.EXTRA_MIME_TYPES"))
        assertTrue(selector.contains("Intent.EXTRA_ALLOW_MULTIPLE, multiple"))
        assertFalse(selector.contains("createChooser"))
        val launch = methodBody(source, "launchFileChooser")
        assertTrue(launch.contains("startActivityForResult(intent, requestCode)"))
        assertTrue(launch.contains("ActivityNotFoundException"))
        assertTrue(launch.contains("SecurityException"))
        assertFalse(source.contains("allowContentAccess = true"))
        assertTrue(selector.contains("toastError(R.string.file_picker_unavailable)"))
        val result = methodBody(source, "finishFileSelection")
        assertFalse(result.contains("toastError"))
        assertFalse(methodBody(source, "invalidateWebFileChooser").contains("toastError"))
    }

    @Test fun resultTakesOnlyItsMatchingRequestBeforeCheckingOwnerAndReturningAllUris() {
        val source = activitySource()
        assertTrue(source.contains("WebFileChooserRequestCodes.owns(requestCode)"))
        val result = methodBody(source, "finishFileSelection")
        assertTrue(result.contains("webFileChooser.take(requestCode) ?: return"))
        assertTrue(result.contains("isCurrentFileChooser(pending.owner)"))
        assertTrue(result.contains("resultCode != RESULT_OK"))
        assertTrue(result.contains("mergeFileChooserItems(clipItems, data?.data)"))
        assertFalse(result.contains("take(1)"))
        val owner = methodBody(source, "isCurrentFileChooser")
        assertTrue(owner.contains("owner.matches(webView, origin.serialized, fileChooserDocument)"))
        assertTrue(owner.contains("GatewayUrlPolicy.isSameOrigin"))
        assertTrue(owner.contains("!isFinishing && !isDestroyed"))
        assertFalse(owner.contains("restoreGeneration"))
    }

    @Test fun supportedNavigationOwnsDocumentChangesAndBlocksSelectionUntilItsExactCompletion() {
        val source = activitySource()
        val browser = methodBody(source, "showBrowser")
        val started = browser.substringAfter("override fun onNavigationStarted(").substringBefore("override fun onNavigationCompleted(")
        assertTrue(started.contains("ownsBrowser() && !navigation.isSameDocument"))
        assertTrue(started.contains("fileChooserTransitions.begin(navigation)"))
        assertTrue(started.contains("invalidateWebFileChooser()"))
        val completed = browser.substringAfter("override fun onNavigationCompleted(").substringBefore("fileChooserNavigationListener = listener")
        assertTrue(completed.contains("if (ownsBrowser()) fileChooserTransitions.complete(navigation)"))
        assertFalse(completed.contains("didCommit()"))
        assertTrue(browser.contains("java.util.concurrent.Executor { task -> task.run() }"))
        val legacy = browser.substringAfter("onTopLevelUrlChanged =").substringBefore("onLoaded =")
        assertTrue(legacy.contains("if (fileChooserNavigationListener == null) invalidateWebFileChooser()"))
        assertTrue(methodBody(source, "isCurrentFileChooser").contains("!fileChooserTransitions.active"))
        val teardown = methodBody(source, "destroyWebView")
        assertTrue(teardown.contains("removeNavigationListener(this, it)"))
        assertTrue(teardown.contains("fileChooserTransitions.clear()"))
    }

    private fun methodBody(source: String, name: String): String =
        source.substringAfter("private fun $name(").substringBefore("\n    private fun ")

    private fun activitySource(): String = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
        .flatMap { base -> listOf("src/main", "app/src/main", "apps/mobile/android/app/src/main").asSequence()
            .map { File(base, "$it/java/io/github/sayach/dshmobile/MainActivity.kt") } }
        .first { it.isFile }.readText()
}
