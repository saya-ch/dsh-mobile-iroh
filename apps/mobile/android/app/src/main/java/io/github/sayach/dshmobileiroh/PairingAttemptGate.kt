package io.github.sayach.dshmobileiroh

/** One manual pairing owner shared by button, keyboard and scanned-link submissions. */
internal class PairingAttemptGate {
    @Volatile
    var generation = 0
        private set

    var busy = false
        private set

    /** Reject repeated submissions without withdrawing the result of the active request. */
    fun begin(): Int? {
        if (busy) return null
        generation += 1
        busy = true
        return generation
    }

    /** Allow a retry only after the current attempt reports a result to its owning form. */
    fun complete(expectedGeneration: Int): Boolean {
        if (generation != expectedGeneration) return false
        busy = false
        return true
    }

    /** An explicit navigation away withdraws both queued work and late form callbacks. */
    fun invalidate() {
        generation += 1
        busy = false
    }
}
