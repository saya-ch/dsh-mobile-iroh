package io.github.sayach.dshmobileiroh

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RendererRecoveryPolicyTest {
    @Test
    fun twoCrashesMayRecoverButTheThirdStopsTheLoop() {
        val first = rendererRecoveryDecision(emptyList(), 1_000)
        val second = rendererRecoveryDecision(first.recentCrashes, 2_000)
        val third = rendererRecoveryDecision(second.recentCrashes, 3_000)

        assertTrue(first.retry)
        assertTrue(second.retry)
        assertFalse(third.retry)
    }

    @Test
    fun aLaterCrashCanRecoverAfterTheWindowPasses() {
        val decision = rendererRecoveryDecision(listOf(1_000, 2_000), 62_000)

        assertTrue(decision.retry)
        assertTrue(decision.recentCrashes == listOf(62_000L))
    }
}
