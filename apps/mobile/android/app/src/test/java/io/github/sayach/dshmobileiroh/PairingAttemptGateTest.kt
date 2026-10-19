package io.github.sayach.dshmobileiroh

import java.util.ArrayDeque
import org.junit.Assert.*
import org.junit.Test

class PairingAttemptGateTest {
    @Test fun buttonAndImeSubmissionsShareTheOneSuccessfulPairingOwner() {
        val gate = PairingAttemptGate()
        val completed = ArrayDeque<() -> Unit>()
        var requests = 0
        var storedToken: String? = null
        fun submit() {
            val generation = gate.begin() ?: return
            requests++
            completed.add {
                if (generation == gate.generation) {
                    storedToken = "first successful device token"
                    gate.complete(generation)
                }
            }
        }
        submit()
        repeat(10) { submit() }
        assertTrue(gate.busy)
        assertEquals(1, requests)
        completed.removeFirst()()
        assertEquals("first successful device token", storedToken)
        assertFalse(gate.busy)
    }

    @Test fun explicitNavigationWithdrawsTheOldSuccessWithoutUnlockingANewerAttempt() {
        val gate = PairingAttemptGate()
        val previous = gate.begin()!!
        gate.invalidate()
        val current = gate.begin()!!
        assertNotEquals(previous, current)
        assertFalse(gate.complete(previous))
        assertTrue(gate.busy)
        assertEquals(current, gate.generation)
        assertTrue(gate.complete(current))
        assertFalse(gate.busy)
    }

    @Test fun failedCurrentAttemptsAllowRetryAndRepeatedCompletionDoesNotReplaceAnOwner() {
        val gate = PairingAttemptGate()
        val failed = gate.begin()!!
        assertTrue(gate.complete(failed))
        val retry = gate.begin()!!
        assertFalse(gate.complete(failed))
        assertTrue(gate.busy)
        assertNull(gate.begin())
        assertEquals(retry, gate.generation)
        gate.invalidate()
        assertFalse(gate.busy)
        assertFalse(gate.complete(retry))
    }
}
