package io.github.sayach.dshmobileiroh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Deterministic UI-thread transitions with held queue results and controlled deadline delivery. */
class ConnectionAttemptControllerTest {
    @Test
    fun aConnectionCanBeCancelledImmediatelyBeforeItsQueuedWorkStarts() {
        val fixture = Fixture()
        val outcomes = mutableListOf<ConnectionAttemptController.Reason>()
        val attempt = fixture.controller.start(30_000, outcomes::add)
        var opened = false
        val queuedWork = Runnable {
            if (fixture.controller.isCurrent(attempt)) opened = true
        }

        assertTrue(fixture.controller.isCurrent(attempt))
        assertTrue(fixture.controller.cancel(attempt))
        queuedWork.run()

        assertFalse(opened)
        assertTrue(attempt.cancellation.isCancelled)
        assertFalse(fixture.controller.isCurrent(attempt))
        assertEquals(listOf(ConnectionAttemptController.Reason.CANCELLED), outcomes)
        assertTrue(fixture.scheduler.entries.single().disposed)
    }

    @Test
    fun theOverallDeadlineIncludesWaitingInTheNetworkQueueAndRejectsLateSuccess() {
        val fixture = Fixture()
        val outcomes = mutableListOf<ConnectionAttemptController.Reason>()
        val attempt = fixture.controller.start(30_000, outcomes::add)
        var delivered = 0
        val heldSuccess = Runnable {
            if (fixture.controller.isCurrent(attempt)) delivered += 1
        }

        fixture.scheduler.advanceTo(29_999)
        assertTrue(fixture.controller.isCurrent(attempt))
        fixture.scheduler.advanceTo(30_000)
        heldSuccess.run()

        assertEquals(0, delivered)
        assertTrue(attempt.cancellation.isCancelled)
        assertFalse(fixture.controller.finish(attempt))
        assertEquals(listOf(ConnectionAttemptController.Reason.TIMED_OUT), outcomes)
    }

    @Test
    fun retriesKeepTheOriginalDeadlineInsteadOfStartingAnotherBudget() {
        val fixture = Fixture()
        val outcomes = mutableListOf<ConnectionAttemptController.Reason>()
        val attempt = fixture.controller.start(30_000, outcomes::add)
        var retries = 0
        val retry = Runnable {
            if (fixture.controller.isCurrent(attempt)) retries += 1
        }

        fixture.scheduler.advanceTo(10_000)
        retry.run()
        fixture.scheduler.advanceTo(20_000)
        retry.run()
        assertEquals(1, fixture.scheduler.entries.size)
        fixture.scheduler.advanceTo(30_000)
        retry.run()

        assertEquals(2, retries)
        assertEquals(listOf(ConnectionAttemptController.Reason.TIMED_OUT), outcomes)
    }

    @Test
    fun replacementWithdrawsTheOldConnectionWithoutDeliveringItsTerminalUi() {
        val fixture = Fixture()
        val oldOutcomes = mutableListOf<ConnectionAttemptController.Reason>()
        val newOutcomes = mutableListOf<ConnectionAttemptController.Reason>()
        val previous = fixture.controller.start(30_000, oldOutcomes::add)
        fixture.scheduler.advanceTo(10_000)
        val current = fixture.controller.start(30_000, newOutcomes::add)

        assertTrue(previous.cancellation.isCancelled)
        assertFalse(fixture.controller.isCurrent(previous))
        assertFalse(fixture.controller.finish(previous))
        assertFalse(fixture.controller.cancel(previous))
        assertTrue(fixture.controller.isCurrent(current))
        assertTrue(fixture.scheduler.entries.first().disposed)
        fixture.scheduler.entries.first().task.run()
        assertTrue(fixture.controller.isCurrent(current))
        fixture.scheduler.advanceTo(30_000)
        assertTrue(fixture.controller.isCurrent(current))
        fixture.scheduler.advanceTo(40_000)

        assertTrue(oldOutcomes.isEmpty())
        assertEquals(listOf(ConnectionAttemptController.Reason.TIMED_OUT), newOutcomes)
    }

    @Test
    fun successfulCompletionRemovesTheDeadlineWithoutCancellingItsToken() {
        val fixture = Fixture()
        val outcomes = mutableListOf<ConnectionAttemptController.Reason>()
        val attempt = fixture.controller.start(30_000, outcomes::add)
        var cleanups = 0
        attempt.cancellation.onCancel { cleanups += 1 }

        assertTrue(fixture.controller.finish(attempt))
        assertFalse(fixture.controller.finish(attempt))
        assertFalse(fixture.controller.cancel(attempt))
        assertFalse(fixture.controller.withdraw())
        fixture.scheduler.entries.single().task.run()
        fixture.drainCancellation()

        assertTrue(fixture.scheduler.entries.single().disposed)
        assertFalse(attempt.cancellation.isCancelled)
        assertEquals(0, cleanups)
        assertTrue(outcomes.isEmpty())
    }

    @Test
    fun repeatedCancellationAndLateDeadlineDeliverOneOutcomeAndOneNetworkCleanup() {
        val fixture = Fixture()
        val outcomes = mutableListOf<ConnectionAttemptController.Reason>()
        val attempt = fixture.controller.start(30_000, outcomes::add)
        var cleanups = 0
        attempt.cancellation.onCancel { cleanups += 1 }

        assertTrue(fixture.controller.cancel(attempt))
        assertFalse(fixture.controller.cancel(attempt))
        fixture.scheduler.entries.single().task.run()
        fixture.scheduler.advanceTo(30_000)
        fixture.drainCancellation()

        assertEquals(1, cleanups)
        assertEquals(listOf(ConnectionAttemptController.Reason.CANCELLED), outcomes)
    }

    @Test
    fun withdrawingForNavigationCancelsWithoutReopeningTheConnectionUi() {
        val fixture = Fixture()
        val outcomes = mutableListOf<ConnectionAttemptController.Reason>()
        val attempt = fixture.controller.start(30_000, outcomes::add)

        assertTrue(fixture.controller.withdraw())
        assertFalse(fixture.controller.withdraw())
        fixture.scheduler.entries.single().task.run()

        assertTrue(attempt.cancellation.isCancelled)
        assertFalse(fixture.controller.isCurrent(attempt))
        assertTrue(outcomes.isEmpty())
    }

    @Test
    fun cancellationIsVisibleBeforeNetworkCleanupOrTheTerminalUiCanDeliverLateResults() {
        val fixture = Fixture()
        var ownershipDuringCleanup = true
        var ownershipDuringOutcome = true
        lateinit var attempt: ConnectionAttemptController.Attempt
        attempt = fixture.controller.start(30_000) {
            ownershipDuringOutcome = fixture.controller.isCurrent(attempt)
        }
        attempt.cancellation.onCancel {
            ownershipDuringCleanup = fixture.controller.isCurrent(attempt)
        }

        fixture.controller.cancel(attempt)
        assertFalse(ownershipDuringOutcome)
        assertTrue(attempt.cancellation.isCancelled)
        assertEquals(1, fixture.cancellationQueue.size)
        fixture.drainCancellation()
        assertFalse(ownershipDuringCleanup)
    }

    @Test
    fun aTerminalUiCanStartANewConnectionWithoutBeingWithdrawnByOldCleanup() {
        val fixture = Fixture()
        lateinit var next: ConnectionAttemptController.Attempt
        val previous = fixture.controller.start(30_000) {
            next = fixture.controller.start(30_000) { throw AssertionError("New connection ended") }
        }

        fixture.controller.cancel(previous)
        fixture.scheduler.entries.first().task.run()

        assertTrue(fixture.controller.isCurrent(next))
        assertFalse(next.cancellation.isCancelled)
    }

    @Test
    fun aSynchronousDeadlineIsSettledAndItsReturnedTimerIsDisposed() {
        var disposed = false
        var outcomes = 0
        val controller = ConnectionAttemptController(
            schedule = { _, task ->
                task.run()
                ({ disposed = true })
            },
            cancellationFactory = { NativeConnectionCancellation { task -> task.run() } },
        )

        val attempt = controller.start(1) { outcomes += 1 }

        assertTrue(disposed)
        assertTrue(attempt.cancellation.isCancelled)
        assertFalse(controller.isCurrent(attempt))
        assertEquals(1, outcomes)
    }

    @Test
    fun aRejectedBudgetDoesNotWithdrawTheCurrentConnection() {
        val fixture = Fixture()
        val attempt = fixture.controller.start(30_000) { throw AssertionError("Current connection ended") }

        for (budget in listOf(0L, -1L)) {
            try {
                fixture.controller.start(budget) { throw AssertionError("Invalid connection started") }
                throw AssertionError("Invalid budget was accepted")
            } catch (_: IllegalArgumentException) {
                // Reject invalid caller budgets without disturbing the already active connection.
            }
        }

        assertTrue(fixture.controller.isCurrent(attempt))
        assertEquals(1, fixture.scheduler.entries.size)
    }

    private class Fixture {
        val scheduler = Scheduler()
        val cancellationQueue = ArrayDeque<Runnable>()
        val controller = ConnectionAttemptController(scheduler::schedule) {
            NativeConnectionCancellation { cancellationQueue.addLast(it) }
        }

        fun drainCancellation() {
            while (cancellationQueue.isNotEmpty()) cancellationQueue.removeFirst().run()
        }
    }

    private class Scheduler {
        class Entry(val dueAt: Long, val task: Runnable) {
            var disposed = false
            var delivered = false
        }

        var now = 0L
        val entries = mutableListOf<Entry>()

        fun schedule(delayMs: Long, task: Runnable): () -> Unit {
            val entry = Entry(now + delayMs, task)
            entries += entry
            return { entry.disposed = true }
        }

        fun advanceTo(next: Long) {
            require(next >= now)
            now = next
            while (true) {
                val entry = entries.firstOrNull { !it.disposed && !it.delivered && it.dueAt <= now } ?: return
                entry.delivered = true
                entry.task.run()
            }
        }
    }
}
