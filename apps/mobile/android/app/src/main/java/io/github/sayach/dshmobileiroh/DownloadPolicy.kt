package io.github.sayach.dshmobileiroh

import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

internal const val MAX_DOWNLOAD_BYTES = 256L * 1024 * 1024
internal const val STALE_DOWNLOAD_AGE_MS = 24L * 60 * 60 * 1000
private const val DOWNLOAD_PREFIX = "dsh-download-"
private const val DOWNLOAD_SUFFIX = ".tmp"

/** Copies a download without allowing the response to exceed the mobile storage budget. */
internal fun copyDownloadAtMost(
    input: InputStream,
    output: OutputStream,
    maxBytes: Long = MAX_DOWNLOAD_BYTES,
): Long {
    require(maxBytes >= 0) { "maxBytes must not be negative" }
    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
    var copied = 0L
    while (true) {
        val count = input.read(buffer)
        if (count < 0) return copied
        if (count == 0) {
            val next = input.read()
            if (next < 0) return copied
            if (copied >= maxBytes) throw IOException("Download exceeds the mobile size limit")
            output.write(next)
            copied += 1
            continue
        }
        if (copied > maxBytes - count) throw IOException("Download exceeds the mobile size limit")
        output.write(buffer, 0, count)
        copied += count
    }
}

/** Removes abandoned download staging files after they can no longer belong to a live Activity. */
internal fun cleanupStaleDownloadFiles(
    cacheDirectory: File,
    now: Long = System.currentTimeMillis(),
    staleAgeMs: Long = STALE_DOWNLOAD_AGE_MS,
) {
    if (staleAgeMs < 0) return
    val staleBefore = now - staleAgeMs
    cacheDirectory.listFiles()?.forEach { file ->
        if (file.isFile
            && file.name.startsWith(DOWNLOAD_PREFIX)
            && file.name.endsWith(DOWNLOAD_SUFFIX)
            && file.lastModified() <= staleBefore) {
            file.delete()
        }
    }
}
