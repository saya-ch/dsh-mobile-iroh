package io.github.sayach.dshmobileiroh

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Held callbacks observe complete cookie groups rather than only logical cancellation. */
class NativeSessionCookieInstallerTest {
    private val aliases = listOf("session", "csrf", "host-session", "host-csrf")
    private fun cookies(value: String) = aliases.map { "$it=$value" }
    private fun deletions() = aliases.map { "$it=; Max-Age=0" }

    private class Fixture {
        data class Write(val host: String, val cookie: String, val done: (Boolean) -> Unit)
        val writes = ArrayDeque<Write>()
        val stored = mutableMapOf<String, String>()
        var flushes = 0
        val installer = NativeSessionCookieInstaller<String, String>(
            write = { host, cookie, done -> writes.addLast(Write(host, cookie, done)) },
            flush = { flushes++ },
        )
        fun settle(accepted: Boolean = true): Write {
            val write = writes.removeFirst()
            if (accepted) {
                val key = "${write.host}/${write.cookie.substringBefore('=')}"
                if (write.cookie.contains("Max-Age=0")) stored.remove(key)
                else stored[key] = write.cookie.substringAfter('=').substringBefore(';')
            }
            write.done(accepted)
            return write
        }
    }

    @Test fun cancelledStartedGroupFinishesAliasesButDoesNotCompleteTheOldDocument() {
        val f = Fixture()
        var current = true
        var completed = 0
        f.installer.install("computer", cookies("new"), { current }, { throw AssertionError("failure") }) { completed++ }
        f.settle(); f.settle()
        current = false
        repeat(2) { f.settle() }
        assertEquals(4, f.stored.size)
        assertEquals(setOf("new"), f.stored.values.toSet())
        assertEquals(1, f.flushes)
        assertEquals(0, completed)
    }

    @Test fun aSuccessorCannotOvertakeCancelledPhysicalWorkOrItsFlush() {
        val f = Fixture()
        var current = true
        var nextCompleted = 0
        f.installer.install("computer", cookies("old"), { current }, {}) { throw AssertionError("old completion") }
        current = false
        f.installer.install("computer", cookies("new"), { true }, {}) { nextCompleted++ }
        assertEquals("session=old", f.writes.single().cookie)
        repeat(3) { f.settle(); assertEquals(0, nextCompleted) }
        assertEquals(0, f.flushes)
        f.settle()
        assertEquals(1, f.flushes)
        assertEquals("session=new", f.writes.single().cookie)
        repeat(4) { f.settle() }
        assertEquals(1, nextCompleted)
        assertEquals(2, f.flushes)
        assertEquals(setOf("new"), f.stored.values.toSet())
    }

    @Test fun queuedCancelledDocumentWritesNothingAndCannotBlockItsSuccessor() {
        val f = Fixture()
        var waiting = true
        f.installer.install("computer", cookies("first"), { true }, {}) {}
        f.installer.install("computer", cookies("withdrawn"), { waiting }, {}) { throw AssertionError("withdrawn completion") }
        waiting = false
        f.installer.install("computer", cookies("last"), { true }, {}) {}
        repeat(4) { f.settle() }
        assertEquals("session=last", f.writes.single().cookie)
        repeat(4) { f.settle() }
        assertEquals(setOf("last"), f.stored.values.toSet())
        assertEquals(2, f.flushes)
    }

    @Test fun queuedRevocationClearsTheWholeGroupAfterACancelledRenewalIncludingLateCallbacks() {
        val f = Fixture()
        var current = true
        var cleared = 0
        f.installer.install("computer", cookies("renewed"), { current }, {}) { throw AssertionError("cancelled renewal completion") }
        val first = f.settle()
        current = false
        f.installer.clear("computer", deletions(), { throw AssertionError("clear failure") }) { cleared++ }
        assertEquals("csrf=renewed", f.writes.single().cookie)
        repeat(3) { f.settle() }
        assertEquals("session=; Max-Age=0", f.writes.single().cookie)
        first.done(true)
        assertEquals(1, f.writes.size)
        repeat(4) { f.settle() }
        assertTrue(f.stored.isEmpty())
        assertTrue(f.writes.isEmpty())
        assertEquals(1, cleared)
        assertEquals(2, f.flushes)
        first.done(true)
        assertTrue(f.stored.isEmpty())
    }

    @Test fun anAcceptedClearSurvivesActivityReplacementAndDoesNotDeleteALaterNewSession() {
        val f = Fixture()
        var activityCurrent = true
        var oldUiCompletions = 0
        var newCompletions = 0
        f.installer.install("computer", cookies("old"), { true }, {}) {}
        f.installer.clear("computer", deletions(), {}) { if (activityCurrent) oldUiCompletions++ }
        activityCurrent = false
        f.installer.install("computer", cookies("new"), { true }, {}) { newCompletions++ }
        repeat(4) { f.settle() }
        repeat(4) { f.settle() }
        assertTrue(f.stored.isEmpty())
        assertEquals("session=new", f.writes.single().cookie)
        repeat(4) { f.settle() }
        assertEquals(0, oldUiCompletions)
        assertEquals(1, newCompletions)
        assertEquals(setOf("new"), f.stored.values.toSet())
    }

    @Test fun clearingOneHostDoesNotRemoveAnotherHostsCookiesOrBlockItsWrites() {
        val f = Fixture()
        f.installer.install("first", cookies("first"), { true }, {}) {}
        f.installer.install("second", cookies("second"), { true }, {}) {}
        assertEquals(listOf("first", "second"), f.writes.map { it.host })
        repeat(8) { f.settle() }
        f.installer.clear("first", deletions(), {})
        repeat(4) { f.settle() }
        assertEquals(4, f.stored.size)
        assertTrue(f.stored.keys.all { it.startsWith("second/") })
    }

    @Test fun duplicateOldCallbacksCannotCompleteOrReleaseTheNewOwner() {
        val f = Fixture()
        var completed = 0
        f.installer.install("computer", listOf("session=first"), { true }, {}) {}
        f.installer.install("computer", listOf("session=next", "csrf=next"), { true }, {}) { completed++ }
        val first = f.settle()
        first.done(true); first.done(false)
        assertEquals("session=next", f.writes.single().cookie)
        assertEquals(0, completed)
        f.settle(); f.settle()
        assertEquals(1, completed)
        assertEquals(2, f.flushes)
    }

    @Test fun partialPlatformRejectionIsNotRollbackOrSuccessAndExplicitClearCanFollow() {
        val f = Fixture()
        var failed = 0
        var completed = 0
        f.installer.install("computer", cookies("partial"), { true }, { failed++ }) { completed++ }
        f.installer.clear("computer", deletions(), { throw AssertionError("clear failed") }) { completed++ }
        repeat(3) { f.settle() }
        f.settle(false)
        assertEquals(3, f.stored.size)
        assertEquals(1, failed)
        assertEquals(0, completed)
        assertEquals(0, f.flushes)
        repeat(4) { f.settle() }
        assertEquals(1, completed)
        assertTrue(f.stored.isEmpty())
        assertEquals(1, f.flushes)
    }

    @Test fun clearFailureIsReportedAndNotSilentlyRetriedOrClaimedComplete() {
        val f = Fixture()
        repeat(1) { f.installer.install("computer", cookies("old"), { true }, {}) {} }
        repeat(4) { f.settle() }
        var failed = 0
        var cleared = 0
        f.installer.clear("computer", deletions(), { failed++ }) { cleared++ }
        f.settle(); f.settle(false)
        assertEquals(1, failed)
        assertEquals(0, cleared)
        assertEquals(3, f.stored.size)
        assertTrue(f.writes.isEmpty())
        f.installer.clear("computer", deletions(), { failed++ }) { cleared++ }
        repeat(4) { f.settle() }
        assertTrue(f.stored.isEmpty())
        assertEquals(1, cleared)
    }

    @Test fun synchronousWriteAndFlushFailuresLeaveTheInstallerUsableWithoutFalseSuccess() {
        var failWrite = true
        var failFlush = true
        var failures = 0
        var completions = 0
        val installer = NativeSessionCookieInstaller<String, String>(
            write = { _, _, done -> if (failWrite) throw IllegalStateException("owned write") else done(true) },
            flush = { if (failFlush) throw IllegalStateException("owned flush") },
        )
        fun install() = installer.install("computer", cookies("value"), { true }, { failures++ }) { completions++ }
        install(); assertEquals(1, failures)
        failWrite = false
        install(); assertEquals(2, failures)
        failFlush = false
        install(); assertEquals(2, failures); assertEquals(1, completions)
    }

    @Test fun alreadyCancelledAdmissionDoesNotWriteOrFlush() {
        val f = Fixture()
        f.installer.install("computer", cookies("cancelled"), { false }, { throw AssertionError("failure") }) { throw AssertionError("success") }
        assertTrue(f.writes.isEmpty()); assertEquals(0, f.flushes)
    }

    @Test fun applicationRatherThanAnActivityOwnsTheQueue() {
        val root = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .map { File(it, "apps/mobile/android/app/src/main") }.first { it.isDirectory }
        val source = File(root, "java/io/github/sayach/dshmobileiroh/MobileApplication.kt").readText()
        assertTrue(source.contains("class MobileApplication : Application()"))
        assertTrue(source.contains("val sessionCookieInstaller = NativeSessionCookieInstaller"))
        assertFalse(source.contains("companion object"))
        assertTrue(File(root, "AndroidManifest.xml").readText().contains("android:name=\".MobileApplication\""))
    }
}
