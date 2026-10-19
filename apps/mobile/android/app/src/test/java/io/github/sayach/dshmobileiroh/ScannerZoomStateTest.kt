package io.github.sayach.dshmobileiroh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Small pinch movements accumulate even when the requested ratio stays in one hardware step. */
class ScannerZoomStateTest {
    private val ratios = listOf(100, 150, 200, 300, 400)

    @Test
    fun smallPinchMovementsAccumulateAcrossDiscreteHardwareSteps() {
        val zoom = ScannerZoomState(4, ratios)
        repeat(20) { zoom.applied(zoom.scale(1.03f)) }
        assertTrue(zoom.requestedRatio > 1.8f)
        assertEquals(2, zoom.currentIndex)
        assertEquals(2f, zoom.actualRatio, 0f)
        repeat(20) { zoom.applied(zoom.scale(1f / 1.03f)) }
        assertEquals(0, zoom.currentIndex)
        assertEquals(1f, zoom.actualRatio, 0f)
    }

    @Test
    fun disabledZoomHasNoActionableRange() {
        val zoom = ScannerZoomState(0, null)
        assertFalse(zoom.supported)
        assertEquals(0, zoom.request(4f))
        assertEquals(1f, zoom.requestedRatio, 0f)
        assertEquals(1f, zoom.stepRatio(1), 0f)
    }

    @Test
    fun buttonsChooseAdjacentHardwareStepsAndClampAtBothEnds() {
        val zoom = ScannerZoomState(4, ratios)
        assertEquals(1f, zoom.stepRatio(-1), 0f)
        assertEquals(1.5f, zoom.stepRatio(1), 0f)
        zoom.applied(zoom.request(zoom.stepRatio(1)))
        assertEquals(1, zoom.currentIndex)
        zoom.applied(zoom.request(50f))
        assertEquals(4, zoom.currentIndex)
        assertEquals(4f, zoom.stepRatio(1), 0f)
        zoom.applied(zoom.request(-1f))
        assertEquals(0, zoom.currentIndex)
    }

    @Test
    fun maximumAndActualRatioUseOnlySupportedHardwareIndices() {
        val zoom = ScannerZoomState(2, ratios)
        assertEquals(2f, zoom.maxRatio, 0f)
        zoom.applied(zoom.request(4f))
        assertEquals(2, zoom.currentIndex)
        assertEquals(2f, zoom.actualRatio, 0f)
    }

    @Test
    fun fallbackRatioAndIndicesHaveMatchingBounds() {
        val zoom = ScannerZoomState(10, null)
        zoom.applied(zoom.request(4f))
        assertEquals(10, zoom.currentIndex)
        assertEquals(4f, zoom.actualRatio, 0f)
        assertEquals(3.7f, zoom.stepRatio(-1), 0.001f)
    }

    @Test
    fun incompleteRatioTableDoesNotOfferAnUnreachableIndex() {
        val zoom = ScannerZoomState(4, listOf(100, 200))
        assertEquals(1, zoom.maxIndex)
        zoom.applied(zoom.request(8f))
        assertEquals(1, zoom.currentIndex)
        assertEquals(2f, zoom.maxRatio, 0f)
    }
}
