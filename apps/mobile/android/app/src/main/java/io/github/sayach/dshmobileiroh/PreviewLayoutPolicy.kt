package io.github.sayach.dshmobileiroh

import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Pure geometry and camera-parameter math for the pairing QR scanner. Keeping it free of
 * android.* camera types lets the aspect-fill layout and zoom mapping stay unit tested.
 */
object PreviewLayoutPolicy {
    /** Resolution-independent stand-in for [android.hardware.Camera.Size]. */
    data class Size(val width: Int, val height: Int)

    /** Area of the previous fixed choice; used only as a tie-breaker between aspect matches. */
    private const val TARGET_AREA = 1280.0 * 720.0

    /**
     * Picks the supported preview size with the least aspect mismatch for the current
     * display rotation; resolution close to 720p breaks equal-aspect ties.
     */
    fun choosePreviewSize(sizes: List<Size>, surfaceWidth: Int, surfaceHeight: Int, rotated90: Boolean = true): Size? {
        if (sizes.isEmpty() || surfaceWidth <= 0 || surfaceHeight <= 0) return null
        val surfaceAspect = surfaceWidth.toDouble() / surfaceHeight
        return sizes.filter { it.width > 0 && it.height > 0 }.minWithOrNull(
            compareBy<Size> {
                val aspect = if (rotated90) it.height.toDouble() / it.width else it.width.toDouble() / it.height
                abs(aspect - surfaceAspect)
            }.thenBy { abs(it.width.toDouble() * it.height - TARGET_AREA) },
        )
    }

    /** Legacy Camera display orientation, including front-camera mirror compensation. */
    fun displayOrientation(sensorDegrees: Int, displayDegrees: Int, frontFacing: Boolean): Int =
        if (frontFacing) (360 - (sensorDegrees + displayDegrees) % 360) % 360
        else (sensorDegrees - displayDegrees + 360) % 360

    /**
     * Center-crop ("aspect fill") frame for the preview surface: scales the preview uniformly
     * until it covers the whole screen, cropping the overflow on one axis. Returns
     * [left, top, width, height] relative to the surface so the image is never distorted.
     */
    fun previewFrame(
        surfaceWidth: Int,
        surfaceHeight: Int,
        previewWidth: Int,
        previewHeight: Int,
        rotated90: Boolean = true,
    ): IntArray {
        require(surfaceWidth > 0 && surfaceHeight > 0 && previewWidth > 0 && previewHeight > 0)
        val sw = surfaceWidth
        val sh = surfaceHeight
        val pw = previewWidth
        val ph = previewHeight
        val naturalWidth = if (rotated90) ph else pw
        val naturalHeight = if (rotated90) pw else ph
        val scale = maxOf(sw.toDouble() / naturalWidth, sh.toDouble() / naturalHeight)
        val width = (naturalWidth * scale).roundToInt().coerceAtLeast(sw)
        val height = (naturalHeight * scale).roundToInt().coerceAtLeast(sh)
        return intArrayOf((sw - width) / 2, (sh - height) / 2, width, height)
    }

    /**
     * Maps a desired zoom ratio (1x, 2x, …) to a legacy camera zoom index. Devices that
     * publish per-index zoom ratios get an exact closest match; the fallback assumes the
     * common ~4x maximum grows roughly linearly across indices.
     */
    fun zoomIndexFor(desiredRatio: Float, maxZoom: Int, zoomRatios: List<Int>?): Int {
        if (maxZoom <= 0) return 0
        val ratios = zoomRatios?.takeIf { it.isNotEmpty() }
        return if (ratios != null) {
            val target = (desiredRatio * 100).toInt()
            var best = 0
            var bestDiff = Int.MAX_VALUE
            for (index in 0..minOf(maxZoom, ratios.size - 1)) {
                val diff = abs(ratios[index] - target)
                if (diff < bestDiff) {
                    bestDiff = diff
                    best = index
                }
            }
            best
        } else {
            val clamped = clampZoomRatio(desiredRatio, DEFAULT_MAX_ZOOM_RATIO)
            (maxZoom * (clamped - 1f) / (DEFAULT_MAX_ZOOM_RATIO - 1f)).roundToInt().coerceIn(0, maxZoom)
        }
    }

    fun clampZoomRatio(ratio: Float, maxRatio: Float): Float =
        ratio.coerceIn(1f, maxRatio.coerceAtLeast(1f))

    /** Best-supported zoom ratio from a device's ratio table, or a conservative default. */
    fun maxZoomRatio(zoomRatios: List<Int>?, maxZoom: Int = zoomRatios?.takeIf { it.isNotEmpty() }?.lastIndex ?: 1): Float {
        if (maxZoom <= 0) return 1f
        val ratios = zoomRatios?.takeIf { it.isNotEmpty() } ?: return DEFAULT_MAX_ZOOM_RATIO
        return (ratios[minOf(maxZoom, ratios.lastIndex)] / 100f).coerceAtLeast(1f)
    }

    /** Actual ratio of a valid hardware zoom index, or the matching conservative fallback. */
    fun ratioForZoom(index: Int, maxZoom: Int, zoomRatios: List<Int>?): Float {
        if (maxZoom <= 0) return 1f
        val clamped = index.coerceIn(0, maxZoom)
        val ratios = zoomRatios?.takeIf { it.isNotEmpty() }
        return if (ratios != null) (ratios[minOf(clamped, ratios.lastIndex)] / 100f).coerceAtLeast(1f)
        else 1f + clamped.toFloat() / maxZoom * (DEFAULT_MAX_ZOOM_RATIO - 1f)
    }

    internal const val DEFAULT_MAX_ZOOM_RATIO = 4f
}
