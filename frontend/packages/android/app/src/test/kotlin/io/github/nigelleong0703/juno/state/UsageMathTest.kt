package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.AgentUsage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UsageMathTest {
    @Test fun `an unknown price is never shown as free`() {
        assertEquals("Unknown", UsageMath.spend(0.0, costKnown = false))
        assertEquals("\$1.50", UsageMath.spend(1.5, costKnown = true))
    }

    @Test fun `the bar is clamped and warns above 85 percent`() {
        assertEquals(1f, UsageMath.fraction(1.7), 0f)
        assertEquals(0f, UsageMath.fraction(null), 0f)
        assertFalse(UsageMath.isWarning(0.85))
        assertTrue(UsageMath.isWarning(0.9))
    }

    @Test fun `agents without runs drop out and the rest sort by spend`() {
        val rows = listOf(
            AgentUsage(agentId = "a", runs = 0, costUsd = 9.0),
            AgentUsage(agentId = "b", runs = 2, costUsd = 1.0),
            AgentUsage(agentId = "c", runs = 1, costUsd = 4.0),
        )
        assertEquals(listOf("c", "b"), UsageMath.agentsWithRuns(rows).map { it.agentId })
        assertEquals(3L, UsageMath.totalRuns(rows))
    }

    @Test fun `counts are abbreviated`() {
        assertEquals("999", UsageMath.count(999))
        assertEquals("1.2k", UsageMath.count(1_234))
        assertEquals("3.4M", UsageMath.count(3_400_000))
    }
}
