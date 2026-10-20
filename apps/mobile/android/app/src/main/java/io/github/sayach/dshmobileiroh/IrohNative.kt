package io.github.sayach.dshmobileiroh

/** Optional native iroh transport bridge. HTTPS remains the default transport. */
internal object IrohNative {
    private var loaded = false

    /** Load the native transport when a build includes its ABI library. */
    fun loadIfAvailable(): Boolean {
        if (loaded) return true
        return runCatching {
            System.loadLibrary("dsh_mobile_iroh_android_transport")
            loaded = true
        }.isSuccess
    }

    /** Connect on a worker thread and return the local WebView URL. */
    fun connect(peer: String, code: String?, deviceName: String, dataDirectory: String): String {
        check(loadIfAvailable()) { "iroh native transport is not packaged in this build" }
        return nativeConnect(peer, code.orEmpty(), deviceName, dataDirectory)
    }

    /** Stop the active iroh connection and local proxy. */
    fun close() {
        if (loaded) nativeClose()
    }

    private external fun nativeConnect(peer: String, code: String, deviceName: String, dataDirectory: String): String
    private external fun nativeClose()
}
