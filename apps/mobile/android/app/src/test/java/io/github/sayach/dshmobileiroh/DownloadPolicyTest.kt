package io.github.sayach.dshmobileiroh

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.nio.file.Files

class DownloadPolicyTest {
    @Test
    fun copiesResponsesWithinTheLimit() {
        val output = ByteArrayOutputStream()

        assertEquals(4, copyDownloadAtMost(ByteArrayInputStream(byteArrayOf(1, 2, 3, 4)), output, 4))
        assertArrayEquals(byteArrayOf(1, 2, 3, 4), output.toByteArray())
    }

    @Test
    fun rejectsResponsesOverTheLimitBeforeWritingTheOverflowingChunk() {
        val output = ByteArrayOutputStream()

        assertThrows(IOException::class.java) {
            copyDownloadAtMost(ByteArrayInputStream(ByteArray(DEFAULT_BUFFER_SIZE + 1)), output, DEFAULT_BUFFER_SIZE.toLong())
        }
        assertEquals(DEFAULT_BUFFER_SIZE, output.size())
    }

    @Test
    fun removesOnlyStaleDownloadStagingFiles() {
        val directory = Files.createTempDirectory("dsh-download-policy").toFile()
        try {
            val stale = directory.resolve("dsh-download-stale.tmp").apply { writeText("stale") }
            val fresh = directory.resolve("dsh-download-fresh.tmp").apply { writeText("fresh") }
            val unrelated = directory.resolve("other.tmp").apply { writeText("other") }
            stale.setLastModified(1_000)
            fresh.setLastModified(9_000)
            unrelated.setLastModified(1_000)

            cleanupStaleDownloadFiles(directory, now = 10_000, staleAgeMs = 5_000)

            assertFalse(stale.exists())
            assertTrue(fresh.exists())
            assertTrue(unrelated.exists())
        } finally {
            directory.deleteRecursively()
        }
    }
}
