package io.github.sayach.dshmobileiroh

import android.webkit.PermissionRequest
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebViewPermissionPolicyTest {
    private val trusted = GatewayOrigin.parse("https://192.168.50.23:8443")!!
    private val page = "https://192.168.50.23:8443"
    private val audio = listOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)

    @Test
    fun microphoneCaptureIsGrantedForTheTrustedPageAlone() {
        assertTrue(WebViewPermissionPolicy.shouldGrantAudioCapture(audio, page, trusted))
        assertTrue(WebViewPermissionPolicy.shouldGrantAudioCapture(audio, "$page/", trusted))
        assertFalse(WebViewPermissionPolicy.shouldGrantAudioCapture(audio, "https://192.168.50.24:8443", trusted))
        assertFalse(WebViewPermissionPolicy.shouldGrantAudioCapture(audio, "https://192.168.50.23:8444", trusted))
        assertFalse(WebViewPermissionPolicy.shouldGrantAudioCapture(audio, "https://evil.example", trusted))
        assertFalse(WebViewPermissionPolicy.shouldGrantAudioCapture(audio, "http://192.168.50.23:8443", trusted))
        assertFalse(WebViewPermissionPolicy.shouldGrantAudioCapture(audio, null, trusted))
    }

    @Test
    fun everyOtherRequestStaysDenied() {
        assertFalse(WebViewPermissionPolicy.shouldGrantAudioCapture(listOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE), page, trusted))
        assertFalse(WebViewPermissionPolicy.shouldGrantAudioCapture(
            listOf(PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID, PermissionRequest.RESOURCE_MIDI_SYSEX),
            page,
            trusted,
        ))
        assertFalse(WebViewPermissionPolicy.shouldGrantAudioCapture(emptyList(), page, trusted))
        // Voice input must not turn a mixed camera/microphone request into a partial grant.
        assertFalse(WebViewPermissionPolicy.shouldGrantAudioCapture(
            listOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE) + audio,
            page,
            trusted,
        ))
    }
}
