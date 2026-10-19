package io.github.sayach.dshmobileiroh

import java.util.ArrayDeque
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.*
import org.junit.Test

class DeviceStatusPollerTest {
    private class QueuedExecutor : Executor {
        val work = ArrayDeque<Runnable>()
        override fun execute(command: Runnable) { work.add(command) }
        fun next() { work.removeFirst().run() }
    }

    private fun device(seed: Char = 'a', token: Char = 'T') = PairedDeviceRecord(
        instanceId = seed.toString().repeat(64), deviceId = "d".repeat(32),
        displayName = "Computer $seed", mode = AccessMode.REMOTE,
        origin = GatewayOrigin.parse("https://computer.example")!!,
        deviceToken = token.toString().repeat(43), expiresAt = 9999999999999L,
        caCertificate = null, lastConnectedAt = 10L, lastReachableAt = 10L,
        status = PairedDeviceStatus.UNKNOWN,
    )

    private fun result(device: PairedDeviceRecord) =
        NativeProbe(device.origin, device.instanceId, device.deviceId, device.expiresAt)

    @Test fun repeatedListTicksKeepOneProbeAndAcceptItsSlowCurrentResult() {
        val executor = QueuedExecutor()
        val observed = mutableListOf<String>()
        var calls = 0
        val poller = DeviceStatusPoller(executor, { it() }, { calls++; result(it) }, { row, _ -> observed += row.key })
        repeat(30) { poller.refresh(listOf(device())) }
        assertEquals(1, executor.work.size)
        executor.next()
        assertEquals(1, calls)
        assertEquals(listOf(device().key), observed)
        assertTrue(executor.work.isEmpty())
    }

    @Test fun twoBlockedProbesLeaveTheThirdExistingRestoreThreadAvailable() {
        val executor = Executors.newFixedThreadPool(3)
        val started = CountDownLatch(2)
        val release = CountDownLatch(1)
        val completed = CountDownLatch(4)
        val active = AtomicInteger()
        val maxActive = AtomicInteger()
        val calls = AtomicInteger()
        val poller = DeviceStatusPoller(executor, { it() }, { row ->
            calls.incrementAndGet()
            val current = active.incrementAndGet()
            maxActive.accumulateAndGet(current, ::maxOf)
            started.countDown()
            try {
                check(release.await(5, TimeUnit.SECONDS)) { "probe release was not signalled" }
                result(row)
            } finally { active.decrementAndGet() }
        }, { _, _ -> completed.countDown() })
        try {
            val devices = listOf(device('a'), device('b'), device('c'), device('d'))
            poller.refresh(devices)
            assertTrue(started.await(3, TimeUnit.SECONDS))
            repeat(30) { poller.refresh(devices) }
            assertEquals(2, calls.get())
            assertEquals("interactive restore", executor.submit<String> { "interactive restore" }.get(3, TimeUnit.SECONDS))
            release.countDown()
            assertTrue(completed.await(3, TimeUnit.SECONDS))
            assertEquals(4, calls.get())
            assertEquals(2, maxActive.get())
        } finally {
            poller.stop()
            release.countDown()
            executor.shutdownNow()
            assertTrue(executor.awaitTermination(3, TimeUnit.SECONDS))
        }
    }

    @Test fun queuedCredentialsThatWereReplacedNeverStartAStaleNetworkRequest() {
        val executor = QueuedExecutor()
        val tokens = mutableListOf<String>()
        val observed = mutableListOf<String>()
        val poller = DeviceStatusPoller(executor, { it() }, { tokens += it.deviceToken; result(it) }, { row, _ -> observed += row.deviceToken })
        poller.refresh(listOf(device()))
        poller.refresh(listOf(device(token = 'N')))
        assertEquals(1, executor.work.size)
        executor.next()
        assertTrue(tokens.isEmpty())
        assertEquals(1, executor.work.size)
        executor.next()
        assertEquals(listOf("N".repeat(43)), tokens)
        assertEquals(tokens, observed)
    }

    @Test fun aStoppedRunningProbeCannotOverlapItsSameDeviceAfterResume() {
        val executor = QueuedExecutor()
        val observed = mutableListOf<String>()
        var calls = 0
        lateinit var poller: DeviceStatusPoller
        poller = DeviceStatusPoller(executor, { it() }, { row ->
            calls++
            if (calls == 1) {
                poller.stop()
                poller.refresh(listOf(row))
                assertTrue("paused physical work still owns the device", executor.work.isEmpty())
            }
            result(row)
        }, { row, _ -> observed += row.key })
        poller.refresh(listOf(device()))
        executor.next()
        assertTrue(observed.isEmpty())
        assertEquals(1, executor.work.size)
        executor.next()
        assertEquals(2, calls)
        assertEquals(listOf(device().key), observed)
    }

    @Test fun stopWithdrawsQueuedIoAndUiResultsUntilANewOwnerResumes() {
        val executor = QueuedExecutor()
        val ui = ArrayDeque<() -> Unit>()
        var calls = 0
        var delivered = 0
        val poller = DeviceStatusPoller(executor, { ui.add(it) }, { calls++; result(it) }, { _, _ -> delivered++ })
        poller.refresh(listOf(device('a'), device('b')))
        executor.next()
        poller.stop()
        ui.removeFirst()()
        executor.next()
        assertEquals(1, calls)
        assertEquals(0, delivered)
        poller.refresh(listOf(device('a')))
        executor.next()
        ui.removeFirst()()
        assertEquals(2, calls)
        assertEquals(1, delivered)
    }

    @Test fun removedAndRevokedDevicesDiscardTheirWaitingProbeAndLateResult() {
        for (remaining in listOf(emptyList(), listOf(device().copy(status = PairedDeviceStatus.REVOKED)))) {
            val executor = QueuedExecutor()
            val ui = ArrayDeque<() -> Unit>()
            var calls = 0
            var delivered = 0
            val poller = DeviceStatusPoller(executor, { ui.add(it) }, { calls++; result(it) }, { _, _ -> delivered++ })
            poller.refresh(listOf(device()))
            poller.refresh(remaining)
            executor.next()
            assertEquals(0, calls)
            assertTrue(ui.isEmpty())
            poller.refresh(listOf(device()))
            executor.next()
            poller.refresh(remaining)
            ui.removeFirst()()
            assertEquals(0, delivered)
        }
    }

    @Test fun changedCredentialCannotReceiveAnAlreadyQueuedUiResult() {
        val executor = QueuedExecutor()
        val ui = ArrayDeque<() -> Unit>()
        val delivered = mutableListOf<String>()
        val poller = DeviceStatusPoller(executor, { ui.add(it) }, ::result, { row, _ -> delivered += row.deviceToken })
        poller.refresh(listOf(device()))
        executor.next()
        poller.refresh(listOf(device(token = 'N')))
        ui.removeFirst()()
        assertTrue(delivered.isEmpty())
        executor.next()
        ui.removeFirst()()
        assertEquals(listOf("N".repeat(43)), delivered)
    }

    @Test fun probeAndExecutorFailuresSettleTheirSlotsAndAllowALaterRetry() {
        val executor = QueuedExecutor()
        val observed = mutableListOf<Result<NativeProbe>>()
        var failing = true
        val poller = DeviceStatusPoller(executor, { it() }, {
            if (failing) throw NativeAuthFailure(NativeAuthFailureKind.TIMEOUT)
            result(it)
        }, { _, response -> observed += response })
        poller.refresh(listOf(device()))
        executor.next()
        assertTrue(observed.single().isFailure)
        failing = false
        poller.refresh(listOf(device()))
        executor.next()
        assertTrue(observed.last().isSuccess)

        val rejected = mutableListOf<Result<NativeProbe>>()
        DeviceStatusPoller(Executor { throw RejectedExecutionException("closed owned executor") }, { it() }, ::result, { _, response -> rejected += response })
            .refresh(listOf(device('a'), device('b'), device('c')))
        assertEquals(3, rejected.size)
        assertTrue(rejected.all { it.exceptionOrNull() is RejectedExecutionException })
    }
}
