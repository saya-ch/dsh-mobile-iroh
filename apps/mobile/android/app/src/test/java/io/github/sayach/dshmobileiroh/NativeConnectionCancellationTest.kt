package io.github.sayach.dshmobileiroh

import java.net.URL
import java.security.cert.Certificate
import java.util.ArrayDeque
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeConnectionCancellationTest {
    @Test
    fun cancellationMarksTheAttemptBeforeDispatchingCleanup() {
        val pending = ArrayDeque<Runnable>()
        val cancellation = NativeConnectionCancellation(pending::addLast)
        val cleaned = AtomicInteger()
        cancellation.onCancel { cleaned.incrementAndGet() }
        cancellation.cancel()
        cancellation.cancel()
        assertTrue(cancellation.isCancelled)
        assertEquals(0, cleaned.get())
        assertEquals(1, pending.size)
        assertThrows(NativeConnectionCancelled::class.java) { cancellation.throwIfCancelled() }
        pending.removeFirst().run()
        assertEquals(1, cleaned.get())
    }

    @Test
    fun cleanupExceptionsAreReportedOnceWithoutSkippingOtherResources() {
        val pending = ArrayDeque<Runnable>()
        val failures = mutableListOf<Throwable>()
        val cancellation = NativeConnectionCancellation(pending::addLast, failures::add)
        val failure = IllegalStateException("private cleanup details must not be logged by the token")
        val cleaned = AtomicInteger()
        cancellation.onCancel { throw failure }
        cancellation.onCancel { cleaned.incrementAndGet() }
        cancellation.cancel()
        cancellation.cancel()
        while (pending.isNotEmpty()) pending.removeFirst().run()
        assertEquals(1, cleaned.get())
        assertEquals(1, failures.size)
        assertSame(failure, failures.single())
    }

    @Test
    fun dispatchRejectionIsReportedWithoutSkippingTheNextCleanup() {
        val pending = ArrayDeque<Runnable>()
        val failures = mutableListOf<Throwable>()
        val rejection = java.util.concurrent.RejectedExecutionException("owned executor stopped")
        val dispatched = AtomicInteger()
        val cancellation = NativeConnectionCancellation(
            dispatchCancellation = {
                if (dispatched.incrementAndGet() == 1) throw rejection
                pending.addLast(it)
            },
            onCleanupFailure = failures::add,
        )
        val cleaned = AtomicInteger()
        cancellation.onCancel { throw AssertionError("Rejected cleanup cannot execute") }
        cancellation.onCancel { cleaned.incrementAndGet() }
        cancellation.cancel()
        pending.removeFirst().run()
        assertEquals(1, cleaned.get())
        assertEquals(1, failures.size)
        assertSame(rejection, failures.single())
    }

    @Test
    fun aFailingCleanupReporterDoesNotPreventOtherCleanup() {
        val pending = ArrayDeque<Runnable>()
        val cancellation = NativeConnectionCancellation(
            dispatchCancellation = pending::addLast,
            onCleanupFailure = { throw IllegalStateException("reporter unavailable") },
        )
        val cleaned = AtomicInteger()
        cancellation.onCancel { throw IllegalStateException("cleanup") }
        cancellation.onCancel { cleaned.incrementAndGet() }
        cancellation.cancel()
        while (pending.isNotEmpty()) pending.removeFirst().run()
        assertEquals(1, cleaned.get())
    }

    @Test
    fun fatalCleanupErrorsAreNotConvertedIntoRecoverableFailures() {
        val pending = ArrayDeque<Runnable>()
        val failures = mutableListOf<Throwable>()
        val cancellation = NativeConnectionCancellation(pending::addLast, failures::add)
        val fatal = AssertionError("fatal cleanup")
        cancellation.onCancel { throw fatal }
        cancellation.cancel()
        assertSame(fatal, assertThrows(AssertionError::class.java) { pending.removeFirst().run() })
        assertTrue(failures.isEmpty())
    }

    @Test
    fun registrationAfterCancellationStillCleansItsResource() {
        val pending = ArrayDeque<Runnable>()
        val cancellation = NativeConnectionCancellation(pending::addLast)
        cancellation.cancel()
        val cleaned = AtomicInteger()
        cancellation.onCancel { cleaned.incrementAndGet() }
        assertEquals(0, cleaned.get())
        pending.removeFirst().run()
        assertEquals(1, cleaned.get())
    }

    @Test
    fun releasingARegistrationBeforeCancellationWithdrawsIt() {
        val pending = ArrayDeque<Runnable>()
        val cancellation = NativeConnectionCancellation(pending::addLast)
        val dispose = cancellation.onCancel { throw AssertionError("Released resource was retained") }
        dispose()
        dispose()
        cancellation.cancel()
        assertTrue(pending.isEmpty())
    }

    @Test
    fun separatelyRegisteringTheSameActionDoesNotShareDisposal() {
        val pending = ArrayDeque<Runnable>()
        val cancellation = NativeConnectionCancellation(pending::addLast)
        val cleaned = AtomicInteger()
        val action: () -> Unit = { cleaned.incrementAndGet(); Unit }
        val disposeFirst = cancellation.onCancel(action)
        cancellation.onCancel(action)
        disposeFirst()
        cancellation.cancel()
        pending.removeFirst().run()
        assertEquals(1, cleaned.get())
    }

    @Test
    fun cancellationClaimedBeforeReleaseMayFinishItsCleanup() {
        val pending = ArrayDeque<Runnable>()
        val cancellation = NativeConnectionCancellation(pending::addLast)
        val cleaned = AtomicInteger()
        val dispose = cancellation.onCancel { cleaned.incrementAndGet() }
        cancellation.cancel()
        dispose()
        pending.removeFirst().run()
        assertEquals(1, cleaned.get())
    }

    @Test
    fun cancellingBetweenConnectionCreationAndRegistrationPreventsItsRequest() {
        val pending = ArrayDeque<Runnable>()
        val cancellation = NativeConnectionCancellation(pending::addLast)
        val connection = TestConnection()
        cancellation.cancel()
        assertThrows(NativeConnectionCancelled::class.java) {
            withCancellableNativeConnection(connection, cancellation) { connection.connect() }
        }
        assertEquals(0, connection.requests.get())
        assertEquals(1, connection.disconnections.get())
        pending.removeFirst().run()
        assertEquals(2, connection.disconnections.get())
    }

    @Test
    fun cancellingAnInFlightConnectionDispatchesDisconnectAndPreventsItsNextRequest() {
        val pending = java.util.concurrent.LinkedBlockingQueue<Runnable>()
        val cancellation = NativeConnectionCancellation { pending.add(it) }
        val first = TestConnection()
        val next = TestConnection()
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val executor = Executors.newSingleThreadExecutor()
        try {
            val request = executor.submit {
                assertThrows(NativeConnectionCancelled::class.java) {
                    withCancellableNativeConnection(first, cancellation) {
                        first.connect()
                        started.countDown()
                        check(release.await(10, TimeUnit.SECONDS))
                        cancellation.throwIfCancelled()
                        withCancellableNativeConnection(next, cancellation) { next.connect() }
                    }
                }
            }
            assertTrue(started.await(10, TimeUnit.SECONDS))
            cancellation.cancel()
            assertEquals(0, first.disconnections.get())
            requireNotNull(pending.poll(10, TimeUnit.SECONDS)).run()
            assertEquals(1, first.disconnections.get())
            release.countDown()
            request.get(10, TimeUnit.SECONDS)
            assertEquals(0, next.requests.get())
            assertEquals(2, first.disconnections.get())
        } finally {
            release.countDown()
            executor.shutdownNow()
            assertTrue(executor.awaitTermination(10, TimeUnit.SECONDS))
        }
    }

    @Test
    fun normalCompletionReleasesItsRegistrationAndDisconnectsOnce() {
        val pending = ArrayDeque<Runnable>()
        val cancellation = NativeConnectionCancellation(pending::addLast)
        val connection = TestConnection()
        assertEquals("complete", withCancellableNativeConnection(connection, cancellation) { "complete" })
        assertFalse(cancellation.isCancelled)
        assertEquals(1, connection.disconnections.get())
        cancellation.cancel()
        assertTrue(pending.isEmpty())
    }

    @Test
    fun cleanupCannotReplaceAnAuthenticationOrTlsFailure() {
        for (failure in listOf(NativeAuthFailure(NativeAuthFailureKind.DEVICE_REVOKED), SSLException("rejected"))) {
            val connection = TestConnection().apply { cleanupFailure = IllegalStateException("cleanup") }
            val thrown = assertThrows(Exception::class.java) {
                withCancellableNativeConnection(connection, null) { throw failure }
            }
            assertSame(failure, thrown)
            assertSame(connection.cleanupFailure, thrown.suppressed.single())
        }
    }

    @Test
    fun fatalDisconnectErrorsAreNotSuppressedByAnEarlierOperationFailure() {
        val fatal = AssertionError("fatal disconnect")
        val connection = TestConnection().apply { cleanupFailure = fatal }
        val thrown = assertThrows(AssertionError::class.java) {
            withCancellableNativeConnection(connection, null) { throw SSLException("rejected") }
        }
        assertSame(fatal, thrown)
    }

    @Test
    fun cancelledTokensRejectAllNativeRequestEntryPointsBeforeNetworkWork() {
        val cancellation = NativeConnectionCancellation { throw AssertionError("No connection should be created") }
        cancellation.cancel()
        val origin = requireNotNull(GatewayOrigin.parse("https://example.com"))
        val requests: List<() -> Any?> = listOf(
            { NativeAuthClient.pair(origin, "token", null, "a".repeat(64), cancellation) },
            { NativeAuthClient.renew(origin, "token", null, "a".repeat(64), cancellation) },
            { NativeAuthClient.probe(origin, "token", null, "a".repeat(64), cancellation) },
            { NativeAuthClient.fetchPairingCa(origin, cancellation) },
            { NativeAuthClient.fetchMetadata(origin, cancellation) },
            { NativeAuthClient.fetchDiscovery(origin, cancellation) },
        )
        requests.forEach { operation -> assertThrows(NativeConnectionCancelled::class.java) { operation() } }
    }

    @Test
    fun cancelledDiscoveryRetainsItsPhysicalSlotUntilTheWorkerActuallyExits() {
        val physicalWorker = Executors.newSingleThreadExecutor()
        val owner = Executors.newSingleThreadExecutor()
        val started = CountDownLatch(1)
        val interrupted = CountDownLatch(1)
        val release = CountDownLatch(1)
        try {
            physicalWorker.submit {
                started.countDown()
                while (release.count != 0L) {
                    try {
                        check(release.await(10, TimeUnit.SECONDS))
                    } catch (_: InterruptedException) {
                        interrupted.countDown()
                    }
                }
            }
            assertTrue(started.await(10, TimeUnit.SECONDS))
            val stopped = owner.submit {
                Thread.currentThread().interrupt()
                LanDiscovery.stopExecutor(physicalWorker, retainPhysicalSlot = true)
                assertTrue("Draining must restore its owner's interrupt flag", Thread.currentThread().isInterrupted)
            }
            assertTrue(interrupted.await(10, TimeUnit.SECONDS))
            assertTrue(physicalWorker.isShutdown)
            assertFalse("A cancelled Future is not physical worker exit", stopped.isDone)
            release.countDown()
            stopped.get(10, TimeUnit.SECONDS)
            assertTrue(physicalWorker.isTerminated)
        } finally {
            release.countDown()
            physicalWorker.shutdownNow()
            owner.shutdownNow()
            assertTrue(physicalWorker.awaitTermination(10, TimeUnit.SECONDS))
            assertTrue(owner.awaitTermination(10, TimeUnit.SECONDS))
        }
    }

    private class TestConnection : HttpsURLConnection(URL("https://example.com")) {
        val requests = AtomicInteger()
        val disconnections = AtomicInteger()
        var cleanupFailure: Throwable? = null
        override fun connect() { requests.incrementAndGet() }
        override fun disconnect() {
            disconnections.incrementAndGet()
            cleanupFailure?.let { throw it }
        }
        override fun usingProxy(): Boolean = false
        override fun getCipherSuite(): String = "test"
        override fun getLocalCertificates(): Array<Certificate>? = null
        override fun getServerCertificates(): Array<Certificate> = emptyArray()
    }
}
