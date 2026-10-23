package io.github.sayach.dshmobileiroh

import org.junit.Assert.*
import org.junit.Test

/** Uses held scheduler callbacks; no Android runtime, native library or clock is required. */
class IrohStatusMonitorTest {
    @Test
    fun readyContinuesAtTheConfiguredIntervalWithoutDuplicatingDeliveredTicks() {
        val fixture = Fixture()
        fixture.monitor.start()
        val first = fixture.scheduler.entries.single()

        fixture.scheduler.deliverNext()
        first.task.run()
        fixture.scheduler.deliverNext()

        assertEquals(listOf(1L, 1L), fixture.queries)
        assertEquals(listOf(2_000L, 2_000L, 2_000L), fixture.scheduler.entries.map { it.delayMs })
        assertEquals(1, fixture.scheduler.pendingCount())
        assertTrue(fixture.terminals.isEmpty())
    }

    @Test
    fun navigationBetweenTicksCapturesTheNewDocumentWithoutStoppingTheCurrentCarrier() {
        val fixture = Fixture()
        fixture.monitor.start()
        fixture.owner = fixture.owner!!.copy(documentGeneration = 2)
        fixture.scheduler.deliverNext()
        fixture.owner = fixture.owner!!.copy(documentGeneration = 3)
        fixture.scheduler.deliverNext()

        assertEquals(listOf(1L, 1L), fixture.queries)
        assertTrue(fixture.terminals.isEmpty())
        assertEquals(1, fixture.scheduler.pendingCount())
    }

    @Test
    fun repeatedStopWithdrawsEvenAnAlreadyQueuedCallback() {
        val fixture = Fixture()
        fixture.monitor.start()
        val queued = fixture.scheduler.entries.single()

        fixture.monitor.stop()
        fixture.monitor.stop()
        queued.task.run()

        assertTrue(queued.disposed)
        assertTrue(fixture.queries.isEmpty())
        assertTrue(fixture.terminals.isEmpty())
        assertEquals(0, fixture.scheduler.pendingCount())
        assertEquals(1, fixture.scheduler.entries.size)
    }

    @Test
    fun restartPollsTheNewCarrierAndRejectsThePreviousQueuedCallback() {
        val fixture = Fixture()
        fixture.monitor.start()
        val previous = fixture.scheduler.entries.single()
        fixture.owner = Owner(2)
        fixture.states[2] = IrohTransportStatus.REVOKED

        fixture.monitor.start()
        previous.task.run()
        fixture.scheduler.deliverNext()

        assertTrue(previous.disposed)
        assertEquals(listOf(2L), fixture.queries)
        assertEquals(listOf(2L to IrohTransportStatus.REVOKED), fixture.terminals)
        assertEquals(0, fixture.scheduler.pendingCount())
    }

    @Test
    fun eachTerminalStateDeliversOnceAndDoesNotScheduleAnotherTick() {
        for (terminal in listOf(IrohTransportStatus.REVOKED, IrohTransportStatus.DISCONNECTED, IrohTransportStatus.INACTIVE)) {
            val fixture = Fixture()
            fixture.states[1] = terminal
            fixture.monitor.start()
            val queued = fixture.scheduler.entries.single()

            fixture.scheduler.deliverNext()
            queued.task.run()
            fixture.monitor.stop()

            assertEquals(listOf(1L), fixture.queries)
            assertEquals(listOf(1L to terminal), fixture.terminals)
            assertEquals(1, fixture.scheduler.entries.size)
            assertEquals(0, fixture.scheduler.pendingCount())
        }
    }

    @Test
    fun foregroundEligibilityIsRequiredBeforeSchedulingAndBeforeReadingStatus() {
        val fixture = Fixture()
        fixture.foreground = false
        fixture.monitor.start()
        assertTrue(fixture.scheduler.entries.isEmpty())

        fixture.foreground = true
        fixture.monitor.start()
        fixture.foreground = false
        fixture.scheduler.deliverNext()

        assertTrue(fixture.queries.isEmpty())
        assertTrue(fixture.terminals.isEmpty())
        assertEquals(0, fixture.scheduler.pendingCount())

        fixture.foreground = true
        fixture.monitor.start()
        fixture.scheduler.deliverNext()
        assertEquals(listOf(1L), fixture.queries)
        assertEquals(1, fixture.scheduler.pendingCount())
    }

    @Test
    fun losingThePageOrForegroundDuringAQueryCannotApplyItsTerminalResult() {
        for (change in listOf<(Fixture) -> Unit>(
            { it.foreground = false },
            { it.owner = null },
            { it.owner = it.owner!!.copy(documentGeneration = 2) },
        )) {
            val fixture = Fixture()
            fixture.states[1] = IrohTransportStatus.REVOKED
            fixture.onQuery = { change(fixture) }
            fixture.monitor.start()

            fixture.scheduler.deliverNext()

            assertEquals(listOf(1L), fixture.queries)
            assertTrue(fixture.terminals.isEmpty())
            assertEquals(0, fixture.scheduler.pendingCount())
        }
    }

    @Test
    fun aRestartDuringStatusReadCannotBeStoppedByTheOldResult() {
        val fixture = Fixture()
        fixture.states[1] = IrohTransportStatus.REVOKED
        fixture.onQuery = {
            fixture.onQuery = null
            fixture.owner = Owner(2)
            fixture.monitor.start()
        }
        fixture.monitor.start()

        fixture.scheduler.deliverNext()
        assertTrue(fixture.terminals.isEmpty())
        assertEquals(1, fixture.scheduler.pendingCount())
        fixture.scheduler.deliverNext()

        assertEquals(listOf(1L, 2L), fixture.queries)
        assertTrue(fixture.terminals.isEmpty())
        assertEquals(1, fixture.scheduler.pendingCount())
    }

    @Test
    fun retainedPageRecoveryCanMonitorTheReplacementCarrierAndItsLaterRevocation() {
        val fixture = Fixture()
        val browser = Any()
        fixture.owner = Owner(1, browser)
        fixture.states[1] = IrohTransportStatus.DISCONNECTED
        fixture.onTerminal = {
            fixture.monitor.stop()
            fixture.owner = null
        }
        fixture.monitor.start()
        fixture.scheduler.deliverNext()
        assertEquals(0, fixture.scheduler.pendingCount())

        fixture.owner = Owner(2, browser)
        fixture.states[2] = IrohTransportStatus.REVOKED
        fixture.monitor.start()
        fixture.scheduler.deliverNext()

        assertEquals(listOf(1L, 2L), fixture.queries)
        assertEquals(listOf(1L to IrohTransportStatus.DISCONNECTED, 2L to IrohTransportStatus.REVOKED), fixture.terminals)
        assertEquals(0, fixture.scheduler.pendingCount())
    }

    @Test
    fun terminalHandlingCanStartASuccessorWithoutAnOldCallbackWithdrawingIt() {
        val fixture = Fixture()
        fixture.states[1] = IrohTransportStatus.DISCONNECTED
        fixture.onTerminal = {
            fixture.owner = Owner(2)
            fixture.monitor.start()
        }
        fixture.monitor.start()
        val previous = fixture.scheduler.entries.single()

        fixture.scheduler.deliverNext()
        previous.task.run()
        fixture.scheduler.deliverNext()

        assertEquals(listOf(1L, 2L), fixture.queries)
        assertEquals(listOf(1L to IrohTransportStatus.DISCONNECTED), fixture.terminals)
        assertEquals(1, fixture.scheduler.pendingCount())
    }

    @Test
    fun nonPositiveIntervalsAreRejectedBeforeScheduling() {
        val scheduler = Scheduler()
        for (interval in listOf(0L, -1L)) {
            assertThrows(IllegalArgumentException::class.java) {
                IrohStatusMonitor(
                    intervalMs = interval,
                    schedule = scheduler::schedule,
                    captureOwner = { Owner(1) },
                    isCurrent = { true },
                    status = { IrohTransportStatus.READY },
                    onTerminal = { _, _ -> fail("Invalid monitor delivered a result") },
                )
            }
        }
        assertTrue(scheduler.entries.isEmpty())
    }

    private data class Owner(val carrier: Long, val browser: Any = Any(), val documentGeneration: Int = 1)

    private class Fixture {
        val scheduler = Scheduler()
        var foreground = true
        var owner: Owner? = Owner(1)
        val states = mutableMapOf<Long, IrohTransportStatus>()
        val queries = mutableListOf<Long>()
        val terminals = mutableListOf<Pair<Long, IrohTransportStatus>>()
        var onQuery: (() -> Unit)? = null
        var onTerminal: (() -> Unit)? = null
        val monitor = IrohStatusMonitor(
            intervalMs = 2_000,
            schedule = scheduler::schedule,
            captureOwner = { owner.takeIf { foreground } },
            isCurrent = { observed -> foreground && owner === observed },
            status = { observed ->
                queries += observed.carrier
                onQuery?.invoke()
                states[observed.carrier] ?: IrohTransportStatus.READY
            },
            onTerminal = { observed, status ->
                terminals += observed.carrier to status
                onTerminal?.invoke()
            },
        )
    }

    private class Scheduler {
        class Entry(val delayMs: Long, val task: Runnable) {
            var disposed = false
            var delivered = false
        }

        val entries = mutableListOf<Entry>()

        fun schedule(delayMs: Long, task: Runnable): () -> Unit {
            val entry = Entry(delayMs, task)
            entries += entry
            return { entry.disposed = true }
        }

        fun pendingCount(): Int = entries.count { !it.disposed && !it.delivered }

        fun deliverNext() {
            val entry = entries.first { !it.disposed && !it.delivered }
            entry.delivered = true
            entry.task.run()
        }
    }
}
