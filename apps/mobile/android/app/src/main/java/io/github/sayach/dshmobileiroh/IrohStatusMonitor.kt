package io.github.sayach.dshmobileiroh

/**
 * Polls the foreground transport on its owner's thread. Scheduling must queue callbacks on
 * that same thread. Stop, restart and terminal results withdraw even already queued callbacks.
 * Each query captures the current page and rechecks it before applying a result.
 */
internal class IrohStatusMonitor<Owner>(
    private val intervalMs: Long,
    private val schedule: (delayMs: Long, task: Runnable) -> (() -> Unit),
    private val captureOwner: () -> Owner?,
    private val isCurrent: (Owner) -> Boolean,
    private val status: (Owner) -> IrohTransportStatus,
    private val onTerminal: (Owner, IrohTransportStatus) -> Unit,
) {
    private class Tick {
        var dispose: (() -> Unit)? = null
    }

    private class Polling {
        var next: Tick? = null
    }

    private var current: Polling? = null

    init { require(intervalMs > 0) { "A transport monitor requires a positive interval" } }

    /** Replace any previous poll chain; an absent foreground page leaves monitoring stopped. */
    fun start() {
        stop()
        if (captureOwner() == null) return
        val polling = Polling()
        current = polling
        enqueue(polling)
    }

    /** Withdraw ownership before removing the callback from its scheduler. */
    fun stop() {
        val previous = current
        current = null
        val tick = previous?.next
        previous?.next = null
        tick?.dispose?.invoke()
    }

    private fun enqueue(polling: Polling) {
        val tick = Tick()
        polling.next = tick
        val dispose = schedule(intervalMs, Runnable { poll(polling, tick) })
        if (current === polling && polling.next === tick) tick.dispose = dispose else dispose()
    }

    private fun poll(polling: Polling, tick: Tick) {
        if (current !== polling || polling.next !== tick) return
        polling.next = null
        val owner = captureOwner()
        if (owner == null || !isCurrent(owner)) {
            stop(polling)
            return
        }
        val observed = status(owner)
        if (current !== polling) return
        if (!isCurrent(owner)) {
            stop(polling)
            return
        }
        if (observed == IrohTransportStatus.READY) enqueue(polling)
        else {
            stop(polling)
            onTerminal(owner, observed)
        }
    }

    private fun stop(polling: Polling) {
        if (current === polling) stop()
    }
}
