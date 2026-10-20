package io.github.sayach.dshmobileiroh

import android.content.Context

/** Optional native iroh transport bridge. HTTPS remains the default transport. */
internal object IrohNative : IrohTransportNative {
    @Volatile private var loaded = false
    @Volatile private var initialized = false

    /** DNS and the platform TLS verifier require the process Application Context. */
    @Synchronized
    fun initialize(context: Context) {
        check(loadIfAvailable()) { "iroh native transport is not packaged in this build" }
        if (initialized) return
        nativeInitialize(context.applicationContext)
        initialized = true
    }

    /** Load the native transport when a build includes its ABI library. */
    @Synchronized
    fun loadIfAvailable(): Boolean {
        if (loaded) return true
        return runCatching {
            System.loadLibrary("dsh_mobile_iroh_android_transport")
            loaded = true
        }.isSuccess
    }

    /** Connect on a worker thread and return bounded peer/port metadata, never credentials. */
    override fun connect(requestId: Long, request: IrohConnectionRequest): String {
        check(loadIfAvailable()) { "iroh native transport is not packaged in this build" }
        check(initialized) { "iroh native transport has not been initialized with the Application Context" }
        return nativeConnect(requestId, request.peerId, request.pairingCode.orEmpty(), request.deviceName, request.dataDirectory, request.localPort)
    }

    /** Stop the active iroh connection and local proxy. */
    override fun close(requestId: Long) {
        // Loading here also tombstones a cancelled request whose worker has not entered JNI yet.
        if (loadIfAvailable()) nativeClose(requestId)
    }

    override fun status(requestId: Long): IrohTransportStatus =
        if (!loaded) IrohTransportStatus.INACTIVE else IrohTransportStatus.parse(nativeStatus(requestId))

    private external fun nativeConnect(requestId: Long, peer: String, code: String, deviceName: String, dataDirectory: String, localPort: Int): String
    private external fun nativeClose(requestId: Long)
    private external fun nativeInitialize(context: Context)
    private external fun nativeStatus(requestId: Long): String
}
