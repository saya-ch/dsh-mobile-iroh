package io.github.sayach.dshmobileiroh

import com.google.zxing.BarcodeFormat
import com.google.zxing.common.BitMatrix
import com.google.zxing.qrcode.QRCodeWriter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Verifies the NV21 QR decode pipeline against rendered QRs without a device camera. */
class QrDecoderTest {
    @Test
    fun decodesRenderedPairingLink() {
        val text = "https://192.168.1.20:3443/mobile-access/pair#instance=${"a".repeat(64)}&token=${"A".repeat(43)}"
        val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 256, 256)
        assertEquals(text, QrDecoder.decodeNv21(toGrayscale(matrix, 256), 256, 256))
    }

    @Test
    fun returnsNullForUnstructuredNoise() {
        val noise = ByteArray(100 * 100) { 128.toByte() }
        assertNull(QrDecoder.decodeNv21(noise, 100, 100))
    }

    @Test
    fun returnsNullForTruncatedFrame() {
        assertNull(QrDecoder.decodeNv21(ByteArray(100 * 100), 200, 200))
    }

    @Test
    fun decodesTheUncroppedBufferAtEveryDisplayRotation() {
        val text = "dsh1:test-rotation-pairing-fixture"
        val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 256, 256)
        var width = 480
        var height = 320
        var buffer = ByteArray(width * height) { 0xff.toByte() }
        for (y in 0 until 256) for (x in 0 until 256) {
            buffer[(y + 32) * width + x + 112] = if (matrix.get(x, y)) 0.toByte() else 0xff.toByte()
        }
        repeat(4) {
            assertEquals(text, QrDecoder.decodeNv21(buffer, width, height))
            val rotated = ByteArray(buffer.size)
            for (y in 0 until height) for (x in 0 until width) {
                rotated[x * height + height - 1 - y] = buffer[y * width + x]
            }
            buffer = rotated
            val previousWidth = width
            width = height
            height = previousWidth
        }
    }

    private fun toGrayscale(matrix: BitMatrix, size: Int): ByteArray {
        val data = ByteArray(size * size)
        for (y in 0 until size) {
            for (x in 0 until size) {
                data[y * size + x] = if (matrix.get(x, y)) 0.toByte() else 0xff.toByte()
            }
        }
        return data
    }
}
