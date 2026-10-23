package io.github.sayach.dshmobileiroh

import org.junit.Assert.*
import org.junit.Test

/** Executes the same connection and restore owners as the Activity with a controlled clock. */
class IrohRestoreBudgetTest {
    @Test
    fun failedCarriersKeepTheFirstDeadlineThroughRetryAndRenewal() {
        val fixture = Fixture()
        val attempt = fixture.start()
        var failures = 0
        var renewed = 0
        var nativeCloses = 0
        attempt.cancellation.onCancel { nativeCloses += 1 }
        val firstGeneration = fixture.restores.begin()
        val firstFailure = fixture.result(firstGeneration, attempt) { failures += 1 }

        fixture.advanceTo(30_000)
        firstFailure.run()
        assertTrue(fixture.connections.isCurrent(attempt))
        val secondGeneration = fixture.restores.begin()
        val secondFailure = fixture.result(secondGeneration, attempt) { failures += 1 }
        val heldRenewal = fixture.result(secondGeneration, attempt) { renewed += 1 }
        fixture.advanceTo(59_000)
        secondFailure.run()
        assertEquals(2, failures)
        assertEquals("Retries must not replace the overall timer", 1, fixture.deadlines.size)

        val queuedRetry = fixture.restores.retryCallback { fail("A timed-out retry started another carrier") }
        fixture.advanceTo(60_000)
        queuedRetry.run()
        firstFailure.run()
        secondFailure.run()
        heldRenewal.run()
        fixture.drainCancellation()

        assertEquals(listOf(ConnectionAttemptController.Reason.TIMED_OUT), fixture.outcomes)
        assertEquals(2, failures)
        assertEquals(0, renewed)
        assertEquals(1, nativeCloses)
        assertFalse(fixture.connections.isCurrent(attempt))
        assertFalse(fixture.restores.retryPending)
    }

    @Test
    fun cancellationWithdrawsHeldCarrierResultsAndItsNativeCleanupRunsOnce() {
        val fixture = Fixture()
        val attempt = fixture.start()
        val generation = fixture.restores.begin()
        var nativeCloses = 0
        attempt.cancellation.onCancel { nativeCloses += 1 }
        val success = fixture.result(generation, attempt) { fail("Cancelled carrier continued renewal") }
        val failure = fixture.result(generation, attempt) { fail("Cancelled carrier retried") }

        assertTrue(fixture.connections.cancel(attempt))
        assertFalse(fixture.connections.cancel(attempt))
        success.run()
        failure.run()
        fixture.deadlines.single().task.run()
        fixture.drainCancellation()

        assertEquals(listOf(ConnectionAttemptController.Reason.CANCELLED), fixture.outcomes)
        assertEquals(1, nativeCloses)
        assertTrue(fixture.deadlines.single().disposed)
    }

    @Test
    fun aReplacementConnectionRejectsBothOldCarrierResultsEvenInTheSameRestoreGeneration() {
        val fixture = Fixture()
        val previous = fixture.start()
        val generation = fixture.restores.begin()
        val success = fixture.result(generation, previous) { fail("Old carrier installed into replacement") }
        val failure = fixture.result(generation, previous) { fail("Old carrier failed replacement") }
        fixture.advanceTo(5_000)
        val current = fixture.start()

        success.run()
        failure.run()
        fixture.deadlines.first().task.run()
        assertTrue(fixture.connections.isCurrent(current))
        assertTrue(previous.cancellation.isCancelled)
        assertTrue(fixture.outcomes.isEmpty())
    }

    @Test
    fun aNewRestoreGenerationRejectsOldCarrierResultsWhileKeepingItsConnectionBudget() {
        val fixture = Fixture()
        val attempt = fixture.start()
        val generation = fixture.restores.begin()
        val success = fixture.result(generation, attempt) { fail("Old restore continued renewal") }
        val failure = fixture.result(generation, attempt) { fail("Old restore started a retry") }
        fixture.restores.begin()

        success.run()
        failure.run()
        assertTrue(fixture.connections.isCurrent(attempt))
        assertEquals(1, fixture.deadlines.size)
    }

    @Test
    fun manualFailureSettlesBeforeTheUserStartsAnotherConnectionWithItsOwnBudget() {
        val fixture = Fixture()
        val previous = fixture.start()
        val generation = fixture.restores.begin()
        var deviceLists = 0
        val failure = fixture.result(generation, previous) {
            fixture.connections.withdraw()
            fixture.restores.invalidate()
            deviceLists += 1
        }
        fixture.advanceTo(10_000)
        failure.run()
        failure.run()
        val current = fixture.start()
        fixture.restores.begin()
        fixture.advanceTo(60_000)
        assertEquals(1, deviceLists)
        assertTrue(previous.cancellation.isCancelled)
        assertTrue(fixture.connections.isCurrent(current))
        assertTrue(fixture.outcomes.isEmpty())

        fixture.advanceTo(70_000)
        assertEquals(listOf(ConnectionAttemptController.Reason.TIMED_OUT), fixture.outcomes)
    }

    @Test
    fun carrierSuccessKeepsTheBudgetUntilCookieAndPageCompletionThenFinishesWithoutClosingTransport() {
        val fixture = Fixture()
        val attempt = fixture.start()
        val generation = fixture.restores.begin()
        var renewals = 0
        var nativeCloses = 0
        attempt.cancellation.onCancel { nativeCloses += 1 }
        fixture.result(generation, attempt) { renewals += 1 }.run()
        assertEquals(1, renewals)
        assertTrue(fixture.connections.isCurrent(attempt))

        fixture.advanceTo(40_000)
        assertTrue(fixture.connections.finish(attempt))
        fixture.deadlines.single().task.run()
        fixture.result(generation, attempt) { fail("Completed connection received late failure") }.run()
        fixture.drainCancellation()
        assertTrue(fixture.deadlines.single().disposed)
        assertFalse(attempt.cancellation.isCancelled)
        assertEquals(0, nativeCloses)
        assertTrue(fixture.outcomes.isEmpty())
    }

    private class Fixture {
        class Deadline(val dueAt: Long, val task: Runnable) {
            var disposed = false
            var delivered = false
        }
        private var now = 0L
        val deadlines = mutableListOf<Deadline>()
        val outcomes = mutableListOf<ConnectionAttemptController.Reason>()
        private val cancellation = ArrayDeque<Runnable>()
        val restores = RestoreAttemptGate()
        val connections = ConnectionAttemptController(
            schedule = { delay, task ->
                val deadline = Deadline(now + delay, task)
                deadlines += deadline
                ({ deadline.disposed = true })
            },
            cancellationFactory = { NativeConnectionCancellation { cancellation.addLast(it) } },
        )

        fun start(): ConnectionAttemptController.Attempt = connections.start(60_000) {
            outcomes += it
            restores.invalidate()
        }

        fun result(generation: Int, attempt: ConnectionAttemptController.Attempt, callback: () -> Unit): Runnable =
            restores.connectionCallback(generation, connections, attempt, callback)

        fun advanceTo(time: Long) {
            require(time >= now)
            now = time
            for (deadline in deadlines.toList()) if (!deadline.disposed && !deadline.delivered && deadline.dueAt <= now) {
                deadline.delivered = true
                deadline.task.run()
            }
        }

        fun drainCancellation() {
            while (cancellation.isNotEmpty()) cancellation.removeFirst().run()
        }
    }
}
