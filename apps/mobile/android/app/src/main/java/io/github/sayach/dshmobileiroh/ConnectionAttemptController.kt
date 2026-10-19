package io.github.sayach.dshmobileiroh

/**
 * UI-thread ownership and one overall deadline for a connection, including queued work and retries.
 * All methods and scheduled callbacks run on the UI thread; network consumers observe [Attempt.cancellation].
 * Cancellation withdraws local results, but cannot roll back a pairing already committed by the server.
 */
internal class ConnectionAttemptController(
    private val schedule: (delayMs: Long, task: Runnable) -> (() -> Unit),
    private val cancellationFactory: () -> NativeConnectionCancellation,
) {
    enum class Reason { CANCELLED, TIMED_OUT }

    /** Reuse this owner for every retry and cookie/browser callback in the same connection. */
    class Attempt internal constructor(
        val cancellation: NativeConnectionCancellation,
        internal val onTerminated: (Reason) -> Unit,
    ) {
        internal var disposeDeadline: (() -> Unit)? = null
    }

    private var current: Attempt? = null

    /** Replace prior work silently and start a deadline before any connection work is queued. */
    fun start(budgetMs: Long, onTerminated: (Reason) -> Unit): Attempt {
        require(budgetMs > 0) { "A connection requires a positive overall time budget" }
        val attempt = Attempt(cancellationFactory(), onTerminated)
        val previous = current
        current = attempt
        previous?.let { release(it, cancelNetwork = true) }
        if (current !== attempt) return attempt
        val dispose = schedule(budgetMs, Runnable { terminate(attempt, Reason.TIMED_OUT) })
        if (current === attempt) attempt.disposeDeadline = dispose else dispose()
        return attempt
    }

    /** Late queue, network, cookie and browser results must check ownership before changing the UI. */
    fun isCurrent(attempt: Attempt): Boolean = current === attempt && !attempt.cancellation.isCancelled

    /** Complete successfully without cancelling successful work or delivering a cancellation outcome. */
    fun finish(attempt: Attempt): Boolean {
        if (!isCurrent(attempt)) return false
        current = null
        release(attempt, cancelNetwork = false)
        return true
    }

    /** Immediately withdraw this connection and report cancellation once to its owning UI. */
    fun cancel(attempt: Attempt): Boolean = terminate(attempt, Reason.CANCELLED)

    /** Navigation or Activity disposal withdraws the owner without reopening its previous UI. */
    fun withdraw(): Boolean {
        val attempt = current ?: return false
        current = null
        release(attempt, cancelNetwork = true)
        return true
    }

    private fun terminate(attempt: Attempt, reason: Reason): Boolean {
        if (current !== attempt) return false
        current = null
        release(attempt, cancelNetwork = true)
        attempt.onTerminated(reason)
        return true
    }

    private fun release(attempt: Attempt, cancelNetwork: Boolean) {
        val dispose = attempt.disposeDeadline
        attempt.disposeDeadline = null
        dispose?.invoke()
        if (cancelNetwork) attempt.cancellation.cancel()
    }
}
