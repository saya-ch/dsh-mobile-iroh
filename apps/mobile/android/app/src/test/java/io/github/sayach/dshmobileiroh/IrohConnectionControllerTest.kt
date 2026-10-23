package io.github.sayach.dshmobileiroh

import java.util.ArrayDeque
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class IrohConnectionControllerTest {
    private val request = IrohConnectionRequest("a".repeat(64), "123456", "phone", "/private/test")
    private class Queue : Executor {
        private val tasks = ArrayDeque<Runnable>()
        override fun execute(task: Runnable) { tasks.add(task) }
        fun drain() { while (tasks.isNotEmpty()) tasks.removeFirst().run() }
    }
    private class Native : IrohTransportNative {
        val connected = mutableListOf<Long>()
        val closed = mutableListOf<Long>()
        var action: (() -> Unit)? = null
        var failure: Exception? = null
        override fun connect(requestId: Long, request: IrohConnectionRequest): String {
            connected += requestId
            action?.invoke()
            failure?.let { throw it }
            return metadata
        }
        override fun close(requestId: Long) { closed += requestId }
    }

    @Test
    fun cancelBeforeQueuedWorkerNeverEntersNativeOrDeliversSuccess() {
        val worker = Queue()
        val ui = Queue()
        val native = Native()
        val controller = IrohConnectionController(native, worker, { ui.execute(it) })
        var delivered = false
        val id = controller.connect(request, { delivered = true }, { fail("unexpected failure callback") })
        assertTrue(controller.cancel(id))
        assertFalse(controller.cancel(id))
        worker.drain(); ui.drain()
        assertFalse(delivered)
        assertTrue(native.connected.isEmpty())
        assertEquals(listOf(id), native.closed)
    }

    @Test
    fun replacementRejectsQueuedUiResultAndKeepsNextOwner() {
        val worker = Queue()
        val ui = Queue()
        val native = Native()
        val controller = IrohConnectionController(native, worker, { ui.execute(it) })
        val delivered = mutableListOf<Long>()
        val first = controller.connect(request, { delivered += it.requestId }, { fail() })
        worker.drain()
        val second = controller.connect(request.copy(pairingCode = null), { delivered += it.requestId }, { fail() })
        assertTrue(second > first)
        worker.drain(); ui.drain()
        assertEquals(listOf(second), delivered)
        assertFalse(native.closed.contains(second))
        assertFalse(controller.cancel(first))
        controller.close()
        assertEquals(second, native.closed.last())
    }

    @Test
    fun cancellationInsideNativeCallRejectsItsLateResult() {
        val worker = Queue()
        val ui = Queue()
        val native = Native()
        val controller = IrohConnectionController(native, worker, { ui.execute(it) })
        var delivered = false
        val id = controller.connect(request, { delivered = true }, { fail() })
        native.action = { controller.cancel(id) }
        worker.drain(); ui.drain()
        assertFalse(delivered)
        assertTrue(native.closed.all { it == id })
    }

    @Test
    fun disposeWithdrawsQueuedCallbackAndCannotStartAgain() {
        val worker = Queue()
        val ui = Queue()
        val native = Native()
        val controller = IrohConnectionController(native, worker, { ui.execute(it) })
        var delivered = false
        controller.connect(request, { delivered = true }, { fail() })
        worker.drain()
        controller.close(); controller.close(); ui.drain()
        assertFalse(delivered)
        assertThrows(IllegalStateException::class.java) { controller.connect(request, {}, {}) }
    }

    @Test
    fun nativeFailureIsDeliveredOnceWithoutRetainingResources() {
        val worker = Queue()
        val native = Native().apply { failure = java.io.IOException("iroh:connection_failed") }
        val controller = IrohConnectionController(native, worker, { it() })
        var failures = 0
        val id = controller.connect(request, { fail() }, { failures++ })
        worker.drain()
        assertEquals(1, failures)
        assertEquals(listOf(id), native.closed)
        assertFalse(controller.cancel(id))
        controller.close()
    }

    @Test
    fun cancellationDoesNotWaitForBlockedConnectWorker() {
        val entered = CountDownLatch(1)
        val cancelled = CountDownLatch(1)
        val completed = CountDownLatch(1)
        val native = object : IrohTransportNative {
            override fun connect(requestId: Long, request: IrohConnectionRequest): String {
                entered.countDown()
                check(cancelled.await(2, TimeUnit.SECONDS))
                return metadata
            }
            override fun close(requestId: Long) { cancelled.countDown() }
        }
        val worker = Executors.newSingleThreadExecutor()
        val controller = IrohConnectionController(native, { task ->
            worker.execute { try { task.run() } finally { completed.countDown() } }
        }, { it() })
        try {
            val id = controller.connect(request, { fail("cancelled work was delivered") }, { fail() })
            assertTrue(entered.await(2, TimeUnit.SECONDS))
            assertTrue(controller.cancel(id))
            assertTrue(completed.await(2, TimeUnit.SECONDS))
        } finally {
            controller.close()
            worker.shutdownNow()
            assertTrue(worker.awaitTermination(2, TimeUnit.SECONDS))
        }
    }

    @Test
    fun cleanupFailureIsVisibleButDoesNotRestoreWithdrawnOwner() {
        val native = object : IrohTransportNative {
            override fun connect(requestId: Long, request: IrohConnectionRequest) = metadata
            override fun close(requestId: Long) { throw java.io.IOException("cleanup failed") }
        }
        var failures = 0
        val controller = IrohConnectionController(native, Queue(), { it() }, { failures++ })
        val id = controller.connect(request, {}, {})
        assertTrue(controller.cancel(id))
        assertEquals(1, failures)
        assertFalse(controller.cancel(id))
    }

    @Test
    fun statusIsScopedAndUnknownOrNetworkFailuresCannotBecomeRevoked() {
        val worker = Queue()
        var state = IrohTransportStatus.READY
        val native = object : IrohTransportNative {
            override fun connect(requestId: Long, request: IrohConnectionRequest) = metadata
            override fun close(requestId: Long) = Unit
            override fun status(requestId: Long) = state
        }
        val controller = IrohConnectionController(native, worker, { it() })
        val first = controller.connect(request, {}, { fail() })
        worker.drain()
        assertEquals(IrohTransportStatus.READY, controller.status(first))
        state = IrohTransportStatus.REVOKED
        assertEquals(IrohTransportStatus.REVOKED, controller.status(first))
        val second = controller.connect(request, {}, { fail() })
        assertEquals(IrohTransportStatus.INACTIVE, controller.status(first))
        controller.cancel(second)
        assertEquals(IrohTransportStatus.INACTIVE, controller.status(second))
        assertEquals(IrohTransportStatus.DISCONNECTED, IrohTransportStatus.parse("network_error"))
        assertEquals(IrohTransportStatus.DISCONNECTED, IrohTransportStatus.parse("Revoked"))
    }

    companion object {
        private val metadata = "{\"version\":1,\"peerId\":\"${"a".repeat(64)}\",\"localPort\":25443,\"connectProxyPort\":25444}"
    }
}
