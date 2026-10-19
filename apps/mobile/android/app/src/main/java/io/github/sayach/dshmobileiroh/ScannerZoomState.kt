package io.github.sayach.dshmobileiroh

/** Accumulates pinch input independently of a camera's discrete zoom indices. */
internal class ScannerZoomState(maxIndex: Int, private val ratios: List<Int>?) {
    val maxIndex = if (ratios.isNullOrEmpty()) maxIndex.coerceAtLeast(0)
        else minOf(maxIndex.coerceAtLeast(0), ratios.lastIndex)
    val supported: Boolean get() = maxIndex > 0
    val maxRatio = PreviewLayoutPolicy.maxZoomRatio(ratios, maxIndex)
    var requestedRatio = 1f
        private set
    var actualRatio = 1f
        private set
    var currentIndex = 0
        private set

    fun request(ratio: Float): Int {
        requestedRatio = if (supported) PreviewLayoutPolicy.clampZoomRatio(ratio, maxRatio) else 1f
        return PreviewLayoutPolicy.zoomIndexFor(requestedRatio, maxIndex, ratios)
    }

    fun scale(factor: Float): Int = request(requestedRatio * factor)

    fun stepRatio(direction: Int): Float = PreviewLayoutPolicy.ratioForZoom(
        (currentIndex + direction).coerceIn(0, maxIndex.coerceAtLeast(0)), maxIndex, ratios,
    )

    fun applied(index: Int) {
        currentIndex = index.coerceIn(0, maxIndex.coerceAtLeast(0))
        actualRatio = PreviewLayoutPolicy.ratioForZoom(currentIndex, maxIndex, ratios)
    }
}
