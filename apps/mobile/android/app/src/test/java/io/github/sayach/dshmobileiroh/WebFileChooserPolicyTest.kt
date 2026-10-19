package io.github.sayach.dshmobileiroh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class WebFileChooserPolicyTest {
    @Test fun eligibleImageFiltersUsePhotoPickerOnlyFromSdk33() {
        for (mime in listOf("image/*", "image/jpeg", "image/png", "image/svg+xml")) {
            assertEquals(mime, photoPickerMimeType(33, listOf(mime), capture = false, openMode = true))
            assertEquals(mime, photoPickerMimeType(36, listOf(mime), capture = false, openMode = true))
            assertNull(photoPickerMimeType(32, listOf(mime), capture = false, openMode = true))
        }
    }

    @Test fun documentSelectionKeepsCaptureUnknownModesAndUnrepresentableFilters() {
        for (types in listOf(emptyList(), listOf("*/*"), listOf("application/pdf"), listOf("video/*"),
            listOf("image/png", "image/jpeg"), listOf("image/*", "application/pdf"), listOf("image/"), listOf("image/jp*"))) {
            assertNull(photoPickerMimeType(36, types, capture = false, openMode = true))
        }
        assertNull(photoPickerMimeType(36, listOf("image/*"), capture = true, openMode = true))
        assertNull(photoPickerMimeType(36, listOf("image/*"), capture = false, openMode = false))
    }

    @Test fun multiplePhotoSelectionUsesThePlatformLimitWithoutBroadeningSingleSelection() {
        assertNull(photoPickerSelectionLimit(false, 150))
        assertEquals(150, photoPickerSelectionLimit(true, 150))
        for (limit in listOf(-1, 0, 1)) assertNull(photoPickerSelectionLimit(true, limit))
    }

    @Test fun allClipDataAndDataItemsSurviveInStableOrderWithoutNullsOrDuplicates() {
        assertEquals(listOf("a", "b", "c"), mergeFileChooserItems(listOf("a", null, "b", "a"), "c"))
        assertEquals(listOf("a", "b"), mergeFileChooserItems(listOf("a", "b"), "a"))
        assertEquals(listOf("a"), mergeFileChooserItems(emptyList(), "a"))
        assertEquals(emptyList<String>(), mergeFileChooserItems(emptyList(), null))
    }

    @Test fun ownerMatchesBrowserIdentityExactOriginAndDocumentButNotRestoreGenerations() {
        val browser = Any()
        val owner = WebFileChooserOwner(browser, "https://gateway.example", 8)
        assertTrue(owner.matches(browser, "https://gateway.example", 8))
        assertFalse(owner.matches(Any(), "https://gateway.example", 8))
        assertFalse(owner.matches(browser, "https://other.example", 8))
        assertFalse(owner.matches(browser, "https://gateway.example", 9))
        assertFalse(owner.matches(null, "https://gateway.example", 8))
    }

    @Test fun staleResultCannotConsumeAReplacementAndCompletionIsSingleUse() {
        val gate = WebFileChooserGate<Any>(WebFileChooserRequestCodes())
        val first = Any()
        val old = requireNotNull(gate.begin(first))
        assertNull(gate.begin(Any()))
        assertSame(first, gate.cancel())
        assertNull(gate.cancel())
        val second = Any()
        val current = requireNotNull(gate.begin(second))
        assertTrue(old.requestCode != current.requestCode)
        assertNull(gate.take(old.requestCode))
        assertNull(gate.take(5101))
        assertSame(second, gate.take(current.requestCode))
        assertNull(gate.take(current.requestCode))
    }

    @Test fun aReplacementActivityHasNoOldCallbackAndUsesAProcessUniqueCode() {
        val codes = WebFileChooserRequestCodes()
        val previous = WebFileChooserGate<String>(codes)
        val old = requireNotNull(previous.begin("old callback"))
        assertEquals("old callback", previous.cancel())
        val replacement = WebFileChooserGate<String>(codes)
        val current = requireNotNull(replacement.begin("new callback"))
        assertTrue(current.requestCode > old.requestCode)
        assertNull(replacement.take(old.requestCode))
        assertEquals("new callback", replacement.take(current.requestCode))
    }

    @Test fun savedCounterAdvancesARecreatedProcessWithoutRestoringItsOldCallback() {
        val oldCodes = WebFileChooserRequestCodes()
        val old = requireNotNull(WebFileChooserGate<String>(oldCodes).begin("not restorable"))
        val restoredCodes = WebFileChooserRequestCodes()
        restoredCodes.restoreAtLeast(oldCodes.nextCode())
        val recreated = WebFileChooserGate<String>(restoredCodes)
        assertNull(recreated.take(old.requestCode))
        val current = requireNotNull(recreated.begin("new callback"))
        assertTrue(current.requestCode > old.requestCode)
        assertNull(recreated.take(old.requestCode))
        assertEquals("new callback", recreated.take(current.requestCode))
    }

    @Test fun allocationRejectsBadStateNeverMovesBackwardAndDoesNotRecycleOnExhaustion() {
        val codes = WebFileChooserRequestCodes()
        for (invalid in listOf(-1, 0, Int.MAX_VALUE, WebFileChooserRequestCodes.LAST + 2)) codes.restoreAtLeast(invalid)
        assertEquals(WebFileChooserRequestCodes.FIRST, codes.nextCode())
        codes.restoreAtLeast(WebFileChooserRequestCodes.LAST)
        assertEquals(WebFileChooserRequestCodes.LAST, codes.reserve())
        codes.restoreAtLeast(WebFileChooserRequestCodes.FIRST)
        assertNull(codes.reserve())
        assertNull(WebFileChooserGate<String>(codes).begin("must not reuse"))
        for (code in listOf(4101, 4102, 5101, 5102, -1, WebFileChooserRequestCodes.LAST + 1)) assertFalse(WebFileChooserRequestCodes.owns(code))
        assertTrue(WebFileChooserRequestCodes.owns(WebFileChooserRequestCodes.FIRST))
        assertTrue(WebFileChooserRequestCodes.owns(WebFileChooserRequestCodes.LAST))
    }
}
