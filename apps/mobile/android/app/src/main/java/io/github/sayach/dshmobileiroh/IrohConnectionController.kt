package io.github.sayach.dshmobileiroh

import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicLong

/** Native-only setup parameters. Pairing codes are transient and never form a saved device row. */
internal data class IrohConnectionRequest(
    val peerId: String,
    val pairingCode: String?,
    val deviceName: String,
    val dataDirectory: String,
    val localPort: Int = 25443,
)

/** Request ids scope cleanup so a late result cannot close the next computer's session. */
internal interface IrohTransportNative {
    fun connect(requestId: Long, request: IrohConnectionRequest): String
    fun close(requestId: Long)
    fun status(requestId: Long): IrohTransportStatus = IrohTransportStatus.READY
}

/** Network failures never imply that the computer revoked a device. */
internal enum class IrohTransportStatus {
    READY, REVOKED, DISCONNECTED, INACTIVE;

    companion object {
        fun parse(value: String): IrohTransportStatus = when (value) {
            "ready" -> READY
            "revoked" -> REVOKED
            "inactive" -> INACTIVE
            else -> DISCONNECTED
        }
    }
}

/** An internal carrier address, deliberately separate from the HTTPS [GatewayOrigin]. */
internal data class IrohCarrierSession(val requestId: Long, val endpoint: IrohEndpointMetadata)

/**
 * Owns one native transport independently of Activity and WebView policy.
 * Callbacks dispatch through the owner thread and recheck ownership after queuing.
 * [close] is terminal; cancelling only the current request permits another connection.
 */
internal class IrohConnectionController(
    private val native: IrohTransportNative,
    private val worker: Executor,
    private val dispatch: (() -> Unit) -> Unit,
    private val onCleanupFailure: () -> Unit = {},
) : AutoCloseable {
    private var current: Long? = null
    private var disposed = false

    /** Begin setup, withdrawing the prior owner before its replacement enters JNI. */
    fun connect(
        request: IrohConnectionRequest,
        onConnected: (IrohCarrierSession) -> Unit,
        onFailure: (Throwable) -> Unit,
    ): Long {
        val id = ids.incrementAndGet().also { check(it > 0) { "iroh request id exhausted" } }
        val previous = synchronized(this) {
            check(!disposed) { "iroh transport owner has been disposed" }
            current.also { current = id }
        }
        previous?.let(::release)
        try {
            worker.execute {
                if (!owns(id)) return@execute
                val result = runCatching { IrohEndpointMetadata.parse(native.connect(id, request), request.peerId, request.localPort) }
                if (!owns(id)) { release(id); return@execute }
                try {
                    dispatch {
                        if (!owns(id)) { release(id); return@dispatch }
                        result.fold(
                            onSuccess = { onConnected(IrohCarrierSession(id, it)) },
                            onFailure = {
                                synchronized(this) { if (current == id) current = null }
                                release(id)
                                onFailure(it)
                            },
                        )
                    }
                } catch (failure: Exception) {
                    synchronized(this) { if (current == id) current = null }
                    release(id)
                    throw failure
                }
            }
        } catch (failure: Exception) {
            synchronized(this) { if (current == id) current = null }
            release(id)
            throw failure
        }
        return id
    }

    /** Withdraw a pending or connected owner without changing any persisted credential. */
    fun cancel(requestId: Long): Boolean {
        val cancelled = synchronized(this) {
            if (current != requestId) false else { current = null; true }
        }
        if (cancelled) release(requestId)
        return cancelled
    }

    /** A stale Activity cannot observe or act on another request's native status. */
    fun status(requestId: Long): IrohTransportStatus =
        if (!owns(requestId)) IrohTransportStatus.INACTIVE
        else try { native.status(requestId) } catch (_: Exception) { IrohTransportStatus.DISCONNECTED }

    /** Activity teardown must call this even when a worker is still inside native connect. */
    override fun close() {
        val previous = synchronized(this) {
            disposed = true
            current.also { current = null }
        }
        previous?.let(::release)
    }

    @Synchronized
    internal fun owns(id: Long): Boolean = !disposed && current == id

    private fun release(id: Long) {
        try { native.close(id) } catch (_: Exception) { onCleanupFailure() }
    }

    private companion object {
        // Shared across controller recreation because JNI ownership lasts for the process.
        val ids = AtomicLong(0)
    }
}
