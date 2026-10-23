package io.github.sayach.dshmobileiroh

import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException

/**
 * Deduplicates per-device probes without queuing another network job on every list tick.
 * At most two probes occupy the Activity's three-thread restore executor, leaving capacity
 * for an explicit connection. A stopped request keeps its slot until it actually finishes.
 */
internal class DeviceStatusPoller(
    private val executor: Executor,
    private val dispatch: (() -> Unit) -> Unit,
    private val probe: (PairedDeviceRecord) -> NativeProbe,
    private val onResult: (PairedDeviceRecord, Result<NativeProbe>) -> Unit,
    private val maxConcurrent: Int = 2,
) {
    private class Request(val device: PairedDeviceRecord, val owner: Long)

    private val pending = linkedMapOf<String, PairedDeviceRecord>()
    private val desired = linkedMapOf<String, PairedDeviceRecord>()
    private val running = mutableSetOf<Request>()
    private var owner = 0L
    private var active = false

    init { require(maxConcurrent in 1..2) }

    /** Refresh pending snapshots while retaining current slow probes and their result owners. */
    fun refresh(devices: List<PairedDeviceRecord>) {
        synchronized(this) {
            active = true
            val eligible = devices.filter { it.status != PairedDeviceStatus.REVOKED }.associateBy { it.key }
            desired.clear()
            desired.putAll(eligible)
            pending.keys.retainAll(eligible.keys)
            for (device in eligible.values) {
                val current = running.any { request ->
                    request.owner == owner && PairedDeviceStatusPolicy.mayApplyResult(device, request.device)
                }
                if (current) pending.remove(device.key) else pending[device.key] = device
            }
        }
        pump()
    }

    /** Remove waiting work and withdraw callbacks; running network operations retain their slots. */
    fun stop() {
        synchronized(this) {
            active = false
            owner += 1
            pending.clear()
            desired.clear()
        }
    }

    private fun pump() {
        val requests = synchronized(this) {
            buildList {
                while (active && running.size < maxConcurrent && pending.isNotEmpty()) {
                    // A paused network call still owns its physical slot and device until exit.
                    val entry = pending.entries.firstOrNull { entry ->
                        running.none { it.device.key == entry.key }
                    } ?: break
                    pending.remove(entry.key)
                    val request = Request(entry.value, owner)
                    running.add(request)
                    add(request)
                }
            }
        }
        for (request in requests) {
            try {
                executor.execute {
                    val stillOwned = synchronized(this) { owns(request) }
                    val result = if (stillOwned) runCatching { probe(request.device) } else null
                    finished(request, result)
                }
            } catch (failure: RejectedExecutionException) {
                finished(request, Result.failure(failure))
            }
        }
    }

    private fun finished(request: Request, result: Result<NativeProbe>?) {
        synchronized(this) { running.remove(request) }
        if (result != null) dispatch {
            // Dispatch may wait in the UI queue after the list is hidden or replaced.
            if (synchronized(this) { owns(request) }) onResult(request.device, result)
        }
        pump()
    }

    /** Called under this poller's monitor before network work and UI delivery. */
    private fun owns(request: Request): Boolean = active && request.owner == owner &&
        desired[request.device.key]?.let { PairedDeviceStatusPolicy.mayApplyResult(it, request.device) } == true
}

/** A legacy gateway's trusted renewal remains the fallback when native-probe is unavailable. */
internal fun probeSavedDevice(device: PairedDeviceRecord): NativeProbe {
    if (device.iroh != null) throw NativeAuthFailure(NativeAuthFailureKind.NETWORK)
    return try {
        NativeAuthClient.probe(device.origin, device.deviceToken, device.caCertificate, device.instanceId)
    } catch (failure: NativeAuthFailure) {
        if (failure.kind != NativeAuthFailureKind.INVALID_RESPONSE) throw failure
        val session = NativeAuthClient.renew(device.origin, device.deviceToken, device.caCertificate, device.instanceId)
        NativeProbe(device.origin, device.instanceId, session.deviceId, device.expiresAt)
    }
}
