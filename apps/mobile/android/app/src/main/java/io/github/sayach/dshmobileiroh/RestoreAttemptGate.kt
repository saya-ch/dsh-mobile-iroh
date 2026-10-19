package io.github.sayach.dshmobileiroh

/** UI-owned restore generations; background work can observe a cancellation before posting its result. */
internal class RestoreAttemptGate {
    @Volatile
    var generation: Int = 0
        private set

    @Volatile
    private var pendingRetry: Runnable? = null

    val retryPending: Boolean get() = pendingRetry != null

    /** Start another attempt and withdraw any queued retry from the preceding generation. */
    fun begin(): Int {
        invalidate()
        return generation
    }

    /** Withdraw both late result callbacks and queued retries when their UI owner changes. */
    fun invalidate() {
        generation += 1
        pendingRetry = null
    }

    /** Cancel a queued retry without invalidating the successful renewal that installs its cookies. */
    fun cancelRetry() {
        pendingRetry = null
    }

    fun isCurrent(expectedGeneration: Int): Boolean = generation == expectedGeneration

    /** Deliver a result only to the restore generation which requested it. */
    fun callback(expectedGeneration: Int, operation: () -> Unit): Runnable = Runnable {
        if (isCurrent(expectedGeneration)) operation()
    }

    /** Only the current queued retry can release its slot or start another network attempt. */
    fun retryCallback(operation: () -> Unit): Runnable {
        val expectedGeneration = generation
        val task = object : Runnable {
            override fun run() {
                if (pendingRetry !== this || !isCurrent(expectedGeneration)) return
                pendingRetry = null
                operation()
            }
        }
        pendingRetry = task
        return task
    }
}
