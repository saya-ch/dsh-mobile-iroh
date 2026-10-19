package io.github.sayach.dshmobileiroh

import java.io.IOException
import javax.net.ssl.HttpsURLConnection

/** Cancellation is distinct from a failed network, rejected certificate, or revoked credential. */
internal class NativeConnectionCancelled : IOException("Connection attempt cancelled")

/**
 * Withdraws an attempt synchronously and dispatches its resource cleanup outside the caller.
 * [dispatchCancellation] must accept cleanup until every token owned by its executor is cancelled,
 * and must run blocking cleanup off the UI thread. Cancellation does not wait for resource exit.
 * Cleanup Exceptions are reported through [onCleanupFailure]; fatal Errors are not contained.
 */
internal class NativeConnectionCancellation(
    private val dispatchCancellation: (Runnable) -> Unit,
    private val onCleanupFailure: (Throwable) -> Unit,
) {
    constructor(dispatchCancellation: (Runnable) -> Unit) : this(
        dispatchCancellation,
        { System.err.println("DSH Mobile connection cleanup failed") },
    )

    private val lock = Any()
    private class Registration(val action: () -> Unit)
    private val listeners = linkedSetOf<Registration>()

    @Volatile
    var isCancelled: Boolean = false
        private set

    fun throwIfCancelled() {
        if (isCancelled) throw NativeConnectionCancelled()
    }

    /**
     * Registers cleanup, or dispatches it if cancellation already won the race.
     * The returned idempotent disposer withdraws cleanup unless cancellation already claimed it.
     */
    fun onCancel(action: () -> Unit): () -> Unit {
        val registration = Registration(action)
        val dispatchNow = synchronized(lock) {
            if (isCancelled) true else {
                listeners += registration
                false
            }
        }
        if (dispatchNow) dispatchCleanup(action)
        return { synchronized(lock) { listeners.remove(registration) }; Unit }
    }

    /** Invalidate first; an already claimed cleanup may finish after its registration is disposed. */
    fun cancel() {
        val pending = synchronized(lock) {
            if (isCancelled) return
            isCancelled = true
            listeners.toList().also { listeners.clear() }
        }
        pending.forEach { dispatchCleanup(it.action) }
    }

    private fun dispatchCleanup(action: () -> Unit) {
        try {
            dispatchCancellation(Runnable {
                try {
                    action()
                } catch (failure: Exception) {
                    reportCleanupFailure(failure)
                }
            })
        } catch (failure: Exception) {
            reportCleanupFailure(failure)
        }
    }

    private fun reportCleanupFailure(failure: Exception) {
        try {
            onCleanupFailure(failure)
        } catch (_: Exception) {
            // Reporting must not prevent other resources from receiving their cancellation.
            System.err.println("DSH Mobile connection cleanup failed; failure reporting was unavailable")
        }
    }
}

/** Owns one connection until its calling worker exits, including cancellation before registration. */
internal fun <T> withCancellableNativeConnection(
    connection: HttpsURLConnection,
    cancellation: NativeConnectionCancellation?,
    operation: () -> T,
): T {
    var stopObserving: (() -> Unit)? = null
    var operationFailure: Throwable? = null
    try {
        stopObserving = cancellation?.onCancel { connection.disconnect() }
        cancellation?.throwIfCancelled()
        return operation()
    } catch (failure: Throwable) {
        operationFailure = failure
        throw failure
    } finally {
        stopObserving?.invoke()
        try {
            connection.disconnect()
        } catch (cleanupFailure: Exception) {
            val primary = operationFailure
            if (primary == null) throw cleanupFailure
            if (primary !== cleanupFailure) primary.addSuppressed(cleanupFailure)
        }
    }
}
