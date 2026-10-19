package io.github.sayach.dshmobileiroh

/** A Photo Picker image filter that does not widen the webpage's normalized accept list. */
internal fun photoPickerMimeType(sdk: Int, mimeTypes: List<String>, capture: Boolean, openMode: Boolean): String? {
    if (sdk < 33 || capture || !openMode || mimeTypes.size != 1) return null
    return mimeTypes.single().takeIf {
        it.startsWith("image/") && it.length > "image/".length && (it == "image/*" || !it.contains('*'))
    }
}

/** Multiple Photo Picker selection requires a platform limit greater than one. */
internal fun photoPickerSelectionLimit(multiple: Boolean, platformLimit: Int): Int? =
    if (multiple) platformLimit.takeIf { it > 1 } else null

/** Browser identity and document lifetime, independent of authentication renewal. */
internal data class WebFileChooserOwner<T : Any>(val browser: T, val origin: String, val document: Long) {
    fun matches(currentBrowser: T?, currentOrigin: String?, currentDocument: Long): Boolean =
        browser === currentBrowser && origin == currentOrigin && document == currentDocument
}

/** Process-wide allocation survives Activity replacement; saved state advances a new process past old results. */
internal class WebFileChooserRequestCodes {
    private var next = FIRST

    @Synchronized fun reserve(): Int? = if (next <= LAST) next++ else null
    @Synchronized fun nextCode(): Int = next
    @Synchronized fun restoreAtLeast(savedNextCode: Int) {
        if (savedNextCode in FIRST..(LAST + 1) && savedNextCode > next) next = savedNextCode
    }

    companion object {
        const val FIRST = 0x6000
        const val LAST = 0xFFFE
        fun owns(requestCode: Int): Boolean = requestCode in FIRST..LAST
    }
}

/** One standard WebView callback; stale request codes never consume its replacement. */
internal class WebFileChooserGate<T>(private val codes: WebFileChooserRequestCodes) {
    internal data class Pending<T>(val requestCode: Int, val value: T)
    private var pending: Pending<T>? = null

    fun begin(value: T): Pending<T>? {
        if (pending != null) return null
        val code = codes.reserve() ?: return null
        return Pending(code, value).also { pending = it }
    }

    fun take(requestCode: Int): T? {
        val current = pending ?: return null
        if (current.requestCode != requestCode) return null
        pending = null
        return current.value
    }

    fun cancel(): T? = pending?.value.also { pending = null }
}

/** Preserve all selected items while deduplicating ClipData and Intent.data. */
internal fun <T : Any> mergeFileChooserItems(clipItems: List<T?>, singleItem: T?): List<T> =
    (clipItems.filterNotNull() + listOfNotNull(singleItem)).distinct()

/** In-flight cross-document navigations deny file selection until each navigation completes. */
internal class WebFileChooserTransitions<T : Any> {
    private val pending = mutableSetOf<T>()
    val active: Boolean get() = pending.isNotEmpty()
    fun begin(navigation: T): Boolean = pending.add(navigation)
    fun complete(navigation: T) { pending.remove(navigation) }
    fun clear() { pending.clear() }
}
