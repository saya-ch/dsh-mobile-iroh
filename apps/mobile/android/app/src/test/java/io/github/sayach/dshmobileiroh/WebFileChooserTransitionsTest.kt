package io.github.sayach.dshmobileiroh

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebFileChooserTransitionsTest {
    @Test fun completionOfAnOlderNavigationDoesNotAllowSelectionDuringItsSuccessor() {
        val gate = WebFileChooserTransitions<Any>()
        val first = Any()
        val second = Any()
        assertFalse(gate.active)
        assertTrue(gate.begin(first))
        assertFalse(gate.begin(first))
        assertTrue(gate.begin(second))
        gate.complete(first)
        assertTrue(gate.active)
        gate.complete(first)
        gate.complete(Any())
        assertTrue(gate.active)
        gate.complete(second)
        assertFalse(gate.active)
    }

    @Test fun everyCompletionRemovesItsNavigationWithoutReadingCommitStatus() {
        val gate = WebFileChooserTransitions<Any>()
        val navigation = Any()
        assertTrue(gate.begin(navigation))
        assertTrue(gate.active)
        gate.complete(navigation)
        assertFalse(gate.active)
    }

    @Test fun disposingTheBrowserWithdrawsOnlyItsPendingTransitions() {
        val gate = WebFileChooserTransitions<Any>()
        gate.begin(Any())
        gate.begin(Any())
        gate.clear()
        assertFalse(gate.active)
        assertTrue(gate.begin(Any()))
    }
}
