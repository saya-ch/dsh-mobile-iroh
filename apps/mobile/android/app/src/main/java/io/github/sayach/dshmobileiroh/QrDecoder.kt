package io.github.sayach.dshmobileiroh

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.NotFoundException

/** QR decoding over a Camera NV21 frame, isolated for JVM unit testing. */
internal object QrDecoder {
    private val hints: Map<DecodeHintType, Any> = mapOf(
        DecodeHintType.TRY_HARDER to true,
        DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
    )

    /** Decodes the luminance plane of one NV21 frame, or null when no QR is found. */
    fun decodeNv21(yPlane: ByteArray, width: Int, height: Int): String? {
        if (width <= 0 || height <= 0 || yPlane.size < width * height) return null
        val source = PlanarYUVLuminanceSource(yPlane, width, height, 0, 0, width, height, false)
        val bitmap = BinaryBitmap(HybridBinarizer(source))
        return try {
            MultiFormatReader().apply { setHints(hints) }.decode(bitmap).text
        } catch (_: NotFoundException) {
            null
        }
    }
}
