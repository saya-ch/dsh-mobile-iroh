package io.github.sayach.dshmobileiroh

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.*
import org.junit.Test

/** Checks Android-only wiring in addition to executable parser, store and owner tests. */
class IrohActivityWiringTest {
    @Test
    fun experimentalEntryUsesExistingPairingDeviceBrowserAndCancellationFlow() {
        val source = file("java/io/github/sayach/dshmobileiroh/MainActivity.kt").readText()
        val choices = source.substringAfter("private fun showConnectionChoices()").substringBefore("private fun accessChoice(")
        assertTrue(choices.contains("if (BuildConfig.IROH_NATIVE_ENABLED)"))
        assertTrue(choices.contains("showIrohSetup()"))
        val pairing = source.substringAfter("private fun showIrohSetup(").substringBefore("private fun startIrohCarrier(")
        for (call in listOf("IrohPairingDescriptor.parse", "startConnectionAttempt", "startIrohCarrier", "NativeAuthClient.pair", "IrohHttpsTransport", "savePairedDevice", "showPairedDeviceNamePrompt", "installNativeSession", "showBrowser")) {
            assertTrue("Pairing is missing $call", pairing.contains(call))
        }
        assertTrue(pairing.contains("isSaveEnabled = false"))
        assertTrue(pairing.contains("TYPE_TEXT_VARIATION_PASSWORD"))
        assertTrue(pairing.contains("IME_FLAG_NO_PERSONALIZED_LEARNING"))
        assertTrue(pairing.contains("input.text.clear()"))
        assertTrue(pairing.contains("iroh_pairing_retry_new"))
        val carrier = source.substringAfter("private fun startIrohCarrier(").substringBefore("private fun openAccessMode(")
        assertTrue(carrier.contains("attempt.cancellation.onCancel { irohController.cancel(id) }"))
        assertTrue(source.substringAfter("override fun onDestroy()").substringBefore("private fun handleBack()").contains("irohController.close()"))
    }

    @Test
    fun restoreSelectsPeerBeforeRenewalAndNeverStartsEveryTunnelFromTheDeviceList() {
        val source = file("java/io/github/sayach/dshmobileiroh/MainActivity.kt").readText()
        val restore = source.substringAfter("private fun restoreTrustedDevice(").substringBefore("private fun probeMountedDshPage(")
        assertTrue(restore.indexOf("startIrohCarrier(requestedDevice.iroh, null") < restore.indexOf("NativeAuthClient.renew("))
        assertTrue(restore.contains("transport = transportFor(origin)"))
        assertTrue(source.contains("deviceStatusPoller.refresh(devices.filter { it.iroh == null })"))
        val download = source.substringAfter("private fun finishDownloadSelection(").substringBefore("private fun confirmClearSiteData()")
        assertTrue(download.contains("transport = transportFor(origin)"))
        val config = file("res/xml/network_security_config.xml").readText()
        assertTrue(config.contains("cleartextTrafficPermitted=\"false\""))
        assertFalse(config.contains("cleartextTrafficPermitted=\"true\""))
    }

    @Test
    fun carrierFailureDoesNotFinishTheConnectionBeforeItsRetryOwnerDecides() {
        val source = file("java/io/github/sayach/dshmobileiroh/MainActivity.kt").readText()
        val carrierRestore = source.substringAfter("if (requestedDevice?.iroh != null && !hasIrohTransport(requestedDevice.iroh)) {")
            .substringBefore("if (!isOriginAllowed(preferredOrigin, mode))")
        assertTrue("The carrier restore branch must be inspected", carrierRestore.contains("startIrohCarrier"))
        assertFalse("Carrier failure must retain the original overall connection deadline",
            carrierRestore.contains("finishConnectionAttempt(transportAttempt)"))
        assertEquals("Both carrier outcomes must check restore and connection ownership", 2,
            Regex("restoreAttemptGate\\.connectionCallback\\(generation, connectionAttempts, transportAttempt\\)")
                .findAll(carrierRestore).count())
        assertTrue(carrierRestore.contains("onReady = { carrierReady.run() }, onFailure = carrierFailed::run"))
    }

    @Test
    fun allNewUserFacingPairingStringsExistAcrossTheThreeLocales() {
        val keys = setOf("iroh_access_title", "iroh_access_description", "iroh_pairing_help", "iroh_pairing_label",
            "iroh_pairing_hint", "iroh_pairing_private", "iroh_pairing_invalid", "iroh_pairing_retry_new",
            "connection_mode_iroh", "iroh_status_connect_to_check", "iroh_connect_action", "session_storage_failed")
        for (locale in listOf("values", "values-zh-rCN", "values-it")) {
            val document = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file("res/$locale/strings.xml"))
            val strings = document.getElementsByTagName("string")
            val names = (0 until strings.length).map { strings.item(it).attributes.getNamedItem("name").nodeValue }
            for (key in keys) assertEquals("$locale/$key", 1, names.count { it == key })
        }
    }

    @Test
    fun foregroundRevocationMonitorKeepsTheRowButStopsReconnectAndClearsOnlyThisSession() {
        val source = file("java/io/github/sayach/dshmobileiroh/MainActivity.kt").readText()
        val monitor = source.substringAfter("private val irohStatusMonitor by lazy").substringBefore("private fun warnIfTailscale(")
        for (check in listOf("IrohStatusMonitor<IrohStatusOwner>", "activityResumed", "currentDocumentGeneration", "activeIroh === owner.carrier", "webView === owner.browser", "IrohTransportStatus.REVOKED", "stopIrohTransport()", "cancelAutomaticRecovery()", "handleDeviceRevoked()", "sessionCookieInstaller.clear(", "nativeSessionCookieDeletions()", "key = origin.host")) {
            assertTrue("Monitor missing $check", monitor.contains(check))
        }
        assertFalse(monitor.contains("removeAllCookies"))
        assertFalse(monitor.contains("pairedDeviceStore.remove"))
        assertTrue(source.substringAfter("override fun onPause()").substringBefore("override fun onDestroy()").contains("stopIrohStatusMonitor()"))
        assertTrue(source.contains("private fun stopIrohStatusMonitor() = irohStatusMonitor.stop()"))
        assertTrue(source.contains("private fun startIrohStatusMonitor() = irohStatusMonitor.start()"))
    }

    @Test
    fun sessionWritesUseTheApplicationQueueAndSavedPairingSurvivesPlatformFailure() {
        val source = file("java/io/github/sayach/dshmobileiroh/MainActivity.kt").readText()
        val install = source.substringAfter("private fun installNativeSession(").substringBefore("private fun savePairedDevice(")
        assertTrue(install.contains("(application as MobileApplication).sessionCookieInstaller.install("))
        assertTrue(install.contains("key = origin.host"))
        assertTrue(install.contains("!isFinishing && !isDestroyed && isCurrent()"))
        assertTrue(install.contains("onFailure = onFailure"))
        assertFalse(install.contains("setCookie("))
        val pairing = source.substringAfter("installNativeSession(descriptor.binding.origin, session,")
            .substringAfter("onFailure = {").substringBefore("}) {")
        assertTrue(pairing.contains("showDeviceList()"))
        assertTrue(pairing.contains("toastError(R.string.session_storage_failed)"))
        assertFalse(pairing.contains("failed()"))
    }

    @Test
    fun retainedPageRenewalRestartsTheSameMonitorAsReloadAndResume() {
        val source = file("java/io/github/sayach/dshmobileiroh/MainActivity.kt").readText()
        val retained = source.substringAfter("private fun preserveLiveDocumentOrReload(")
            .substringBefore("private fun finishConnectionWhenPageReady(")
        val keep = retained.substringAfter("RenewedDocumentAction.KEEP -> {")
            .substringBefore("RenewedDocumentAction.RELOAD ->")
        assertTrue(keep.contains("finishConnectionAttempt()"))
        assertTrue(keep.indexOf("startIrohStatusMonitor()") > keep.indexOf("finishConnectionAttempt()"))
        assertTrue(retained.contains("showBrowser(origin, caCertificate, fallbackUrl)"))
        assertTrue(source.substringAfter("override fun onResume()").substringBefore("override fun onPause()").contains("startIrohStatusMonitor()"))
        assertTrue(source.substringAfter("private fun showBrowser(").substringBefore("private fun openTaskNotificationSettings()").contains("startIrohStatusMonitor()"))
    }

    @Test
    fun compatibilityIdentityAndUpdateLinksDoNotPretendToBeTheProductionApp() {
        val source = file("java/io/github/sayach/dshmobileiroh/MainActivity.kt").readText()
        assertFalse(source.contains("VersionCompatibility.evaluate(BuildConfig.VERSION_NAME"))
        assertTrue(source.contains("DSHMobile/\${BuildConfig.MOBILE_COMPATIBILITY_VERSION} DSHMobileIroh/\${BuildConfig.VERSION_NAME}"))
        assertTrue(source.contains("https://github.com/saya-ch/dsh-mobile-iroh/releases"))
        assertFalse(source.contains("https://github.com/saya-ch/dsh-mobile/releases"))
        for (locale in listOf("values", "values-zh-rCN", "values-it")) {
            val document = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file("res/$locale/strings.xml"))
            val strings = document.getElementsByTagName("string")
            val name = (0 until strings.length).map(strings::item).single { it.attributes.getNamedItem("name").nodeValue == "app_name" }
            assertEquals("DSH Mobile iroh", name.textContent)
        }
    }

    @Test
    fun experimentalReleaseSigningCannotAccidentallySelectTheProductionAppKey() {
        val build = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .flatMap { base -> listOf("build.gradle.kts", "app/build.gradle.kts", "apps/mobile/android/app/build.gradle.kts").asSequence().map { File(base, it) } }
            .first { it.isFile && it.readText().contains("val releaseStoreFile") }.readText()
        for (name in listOf("DSH_IROH_ANDROID_KEYSTORE_FILE", "DSH_IROH_ANDROID_KEYSTORE_PASSWORD", "DSH_IROH_ANDROID_KEY_ALIAS", "DSH_IROH_ANDROID_KEY_PASSWORD")) {
            assertTrue(build.contains("providers.environmentVariable(\"$name\")"))
        }
        assertFalse(build.contains("providers.environmentVariable(\"DSH_ANDROID_"))
    }

    private fun file(path: String): File = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
        .flatMap { base -> listOf("src/main", "app/src/main", "apps/mobile/android/app/src/main").asSequence().map { File(base, "$it/$path") } }
        .first { it.isFile }
}
