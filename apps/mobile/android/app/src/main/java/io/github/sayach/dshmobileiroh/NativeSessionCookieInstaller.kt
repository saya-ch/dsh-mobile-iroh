package io.github.sayach.dshmobileiroh

import java.util.concurrent.atomic.AtomicBoolean

/**
 * UI-thread cookie batches serialized per host through their complete platform writes and flush.
 * A started batch finishes its aliases after logical cancellation; only its UI callbacks are withdrawn.
 * Platform rejection ends the batch without retry or success; already committed aliases cannot be rolled back.
 */
internal class NativeSessionCookieInstaller<K : Any, C : Any>(
    private val write: (K, C, (Boolean) -> Unit) -> Unit,
    private val flush: () -> Unit,
) {
    private class Work<K, C>(
        val key: K,
        val cookies: List<C>,
        val isCurrent: () -> Boolean,
        val onFailure: () -> Unit,
        val complete: () -> Unit,
    ) {
        var started = false
    }

    private val active = mutableMapOf<K, Work<K, C>>()
    private val waiting = mutableMapOf<K, ArrayDeque<Work<K, C>>>()

    /** Drop unstarted stale requests; a started batch retains its host slot through physical cleanup. */
    fun install(key: K, cookies: List<C>, isCurrent: () -> Boolean, onFailure: () -> Unit, complete: () -> Unit) {
        if (!isCurrent()) return
        val work = Work(key, cookies.toList(), isCurrent, onFailure, complete)
        if (active.containsKey(key)) {
            val queue = waiting.getOrPut(key) { ArrayDeque() }
            queue.removeAll { !it.isCurrent() }
            queue.addLast(work)
        } else {
            active[key] = work
            installNext(work, 0)
        }
    }


    /**
     * Queue an accepted credential-clear operation after every earlier write for the same host.
     * Unlike a document's install, accepted revocation cleanup survives Activity replacement.
     */
    fun clear(key: K, cookies: List<C>, onFailure: () -> Unit, complete: () -> Unit = {}) {
        install(key, cookies, { true }, onFailure, complete)
    }

    private fun installNext(work: Work<K, C>, index: Int) {
        if (!work.started) {
            if (!work.isCurrent()) {
                release(work)
                return
            }
            work.started = true
        }
        if (index == work.cookies.size) {
            try {
                flush()
                if (work.isCurrent()) work.complete()
            } catch (_: Exception) {
                if (work.isCurrent()) work.onFailure()
            } finally {
                release(work)
            }
            return
        }
        val settled = AtomicBoolean(false)
        try {
            write(work.key, work.cookies[index]) { accepted ->
                if (settled.compareAndSet(false, true)) {
                    if (accepted) installNext(work, index + 1)
                    else fail(work)
                }
            }
        } catch (_: Exception) {
            if (settled.compareAndSet(false, true)) fail(work)
        }
    }

    private fun fail(work: Work<K, C>) {
        try {
            if (work.isCurrent()) work.onFailure()
        } finally {
            release(work)
        }
    }

    private fun release(work: Work<K, C>) {
        if (active[work.key] !== work) return
        active.remove(work.key)
        val queue = waiting.remove(work.key) ?: return
        while (queue.isNotEmpty()) {
            val next = queue.removeFirst()
            if (!next.isCurrent()) continue
            if (queue.isNotEmpty()) waiting[work.key] = queue
            active[next.key] = next
            installNext(next, 0)
            return
        }
    }
}
