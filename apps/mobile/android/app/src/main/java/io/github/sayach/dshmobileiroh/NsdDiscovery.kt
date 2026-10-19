package io.github.sayach.dshmobileiroh

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Bounded Android DNS-SD listener for metadata-only DSH Mobile advertisements. */
internal object NsdDiscovery {
    fun scan(context: Context, timeoutMs: Long, canceled: java.util.concurrent.atomic.AtomicBoolean? = null): List<DiscoveredHarness> {
        val app = context.applicationContext
        val manager = app.getSystemService(Context.NSD_SERVICE) as? NsdManager ?: return emptyList()
        val wifi = app.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        val multicastLock = wifi?.createMulticastLock("dsh-mobile-discovery")?.apply {
            setReferenceCounted(false)
            acquire()
        }
        val active = AtomicBoolean(true)
        val resolving = AtomicBoolean(false)
        val pending = ConcurrentLinkedQueue<NsdServiceInfo>()
        val found = ConcurrentHashMap<String, DiscoveredHarness>()
        val started = CountDownLatch(1)
        lateinit var resolveNext: () -> Unit
        resolveNext = {
            val service = pending.poll()
            if (!active.get() || service == null) {
                resolving.set(false)
            } else {
                manager.resolveService(service, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                        resolving.set(false)
                        resolveNext()
                    }

                    override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                        parse(serviceInfo)?.let { found[it.instanceId] = it }
                        resolving.set(false)
                        resolveNext()
                    }
                })
            }
        }
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) = started.countDown()
            override fun onDiscoveryStopped(serviceType: String) = Unit
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) = started.countDown()
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
            override fun onServiceLost(serviceInfo: NsdServiceInfo) = Unit
            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                if (!active.get()) return
                pending.add(serviceInfo)
                if (resolving.compareAndSet(false, true)) resolveNext()
            }
        }
        return try {
            manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
            started.await(1, TimeUnit.SECONDS)
            val end = System.currentTimeMillis() + timeoutMs
            while (System.currentTimeMillis() < end && canceled?.get() != true) {
                Thread.sleep(200)
            }
            found.values.toList()
        } catch (_: Exception) {
            found.values.toList()
        } finally {
            active.set(false)
            runCatching { manager.stopServiceDiscovery(listener) }
            if (multicastLock?.isHeld == true) multicastLock.release()
        }
    }

    private fun parse(info: NsdServiceInfo): DiscoveredHarness? = runCatching {
        val protocol = info.attributes["protocol"]?.toString(Charsets.UTF_8)?.toIntOrNull()
        val instanceId = info.attributes["instanceId"]?.toString(Charsets.UTF_8).orEmpty()
        val deviceName = info.attributes["deviceName"]?.toString(Charsets.UTF_8)
            ?.takeIf { it.isNotBlank() && it.length <= 63 } ?: return@runCatching null
        val origin = GatewayOrigin.parse(info.attributes["origin"]?.toString(Charsets.UTF_8).orEmpty())
            ?: return@runCatching null
        if (protocol != 1 || !LanDiscovery.INSTANCE_ID.matches(instanceId)
            || origin.port != info.port) return@runCatching null
        DiscoveredHarness(deviceName, origin, instanceId)
    }.getOrNull()

    private const val SERVICE_TYPE = "_dsh-mobile._tcp."
}
