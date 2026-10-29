package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.Goal
import io.github.nigelleong0703.juno.contract.Routine
import io.github.nigelleong0703.juno.contract.RoutineRun
import io.github.nigelleong0703.juno.contract.RoutineTrigger
import io.github.nigelleong0703.juno.contract.Step
import io.github.nigelleong0703.juno.ui.agents.permissions.historyView
import io.github.nigelleong0703.juno.ui.goals.laterToday
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

class AgentsLogicTest {
    @Test fun `routine and goal events upsert and goal deleted removes`() {
        var d = AgentsData()
        d = AgentEvents.apply(d, LiveEvents.parse("""{"type":"routine.updated","routine":{"id":"r1","name":"A"}}""")!!)
        d = AgentEvents.apply(d, LiveEvents.parse("""{"type":"routine.updated","routine":{"id":"r1","name":"B"}}""")!!)
        d = AgentEvents.apply(d, LiveEvents.parse("""{"type":"goal.updated","goal":{"id":"g1","title":"G"}}""")!!)
        assertEquals(listOf("B"), d.routines.map { it.name })
        assertEquals(listOf("g1"), d.goals.map { it.id })
        d = AgentEvents.apply(d, LiveEvents.parse("""{"type":"goal.deleted","goalId":"g1"}""")!!)
        assertEquals(emptyList<Goal>(), d.goals)
        val same = AgentEvents.apply(d, LiveEvents.parse("""{"type":"routine.updated","routine":"bad"}""")!!)
        assertSame(d, same)
    }

    @Test fun `reply style keeps the shared body and only this agent's section`() {
        val text = "Shared intro\n## Ann（a1）\nann likes short\n## Bob（b2）\nbob likes long\n## Other\nshared again"
        assertEquals("Shared intro\n## Ann（a1）\nann likes short\n## Other\nshared again", replyStyle(text, "a1"))
        assertEquals("", replyStyle("   \n", "a1"))
    }

    @Test fun `steps merge by id and sort by index`() {
        val old = listOf(Step(id = "s2", index = 2, title = "old"))
        val merged = mergeSteps(old, listOf(Step(id = "s1", index = 1), Step(id = "s2", index = 2, title = "new")))
        assertEquals(listOf("s1", "s2"), merged.map { it.id })
        assertEquals("new", merged[1].title)
    }

    @Test fun `later today includes past due and stops at local midnight`() {
        val now = Instant.parse("2026-10-22T12:00:00Z")
        fun r(id: String, next: String?, enabled: Boolean = true) = Routine(id = id, enabled = enabled, nextRunAt = next, agentId = "a")
        val out = laterToday(
            listOf(r("late", "2026-10-22T23:59:00Z"), r("past", "2026-10-22T06:00:00Z"), r("tomorrow", "2026-10-23T00:00:00Z"), r("off", "2026-10-22T13:00:00Z", false), r("none", null)),
            null, now, ZoneOffset.UTC,
        )
        assertEquals(listOf("past", "late"), out.map { it.id })
    }

    @Test fun `history collapses rule-allowed rows unless a result filter is set`() {
        val rows = listOf(
            io.github.nigelleong0703.juno.contract.Request(id = "1", outcome = "allowed_rule"), io.github.nigelleong0703.juno.contract.Request(id = "2", outcome = "denied"),
            io.github.nigelleong0703.juno.contract.Request(id = "3", outcome = "allowed_once"),
        )
        val all = historyView(rows, null, null)
        assertEquals(listOf("1"), all.auto.map { it.id })
        assertEquals(listOf("2", "3"), all.rest.map { it.id })
        val ruled = historyView(rows, null, "allowed_rule")
        assertEquals(emptyList<String>(), ruled.auto.map { it.id })
        assertEquals(listOf("1"), ruled.rest.map { it.id })
    }

    @Test fun `calendar lanes share width only while blocks overlap`() {
        fun occ(id: String, at: String) = RoutineCalendar.Block(Instant.parse(at), RoutineCalendar.Occurrence(Routine(id = id), Instant.parse(at), false, null), null)
        val placed = RoutineCalendar.lanes(
            listOf(occ("a", "2026-10-22T09:00:00Z"), occ("b", "2026-10-22T09:20:00Z"), occ("c", "2026-10-22T11:00:00Z")), ZoneOffset.UTC,
        )
        assertEquals(listOf(0 to 2, 1 to 2, 0 to 1), placed.map { it.lane to it.lanes })
    }

    @Test fun `occurrences split into recorded past runs and future fires, and dense routines leave the grid`() {
        val now = Instant.parse("2026-10-22T12:00:00Z")
        val daily = Routine(id = "d", trigger = RoutineTrigger(kind = "schedule", cron = "0 9,15 * * *", tz = "UTC"), runs = listOf(RoutineRun(id = "run", startedAt = "2026-10-22T09:00:05Z", status = "completed")))
        val hourly = Routine(id = "h", trigger = RoutineTrigger(kind = "schedule", cron = "0 * * * *", tz = "UTC"))
        val from = Instant.parse("2026-10-22T00:00:00Z")
        val to = Instant.parse("2026-10-23T00:00:00Z")
        val out = RoutineCalendar.occurrences(listOf(daily, hourly), from, to, now)
        assertEquals(listOf(true to "d", false to "d"), out.map { it.past to it.routine.id })
        assertEquals(listOf("h"), RoutineCalendar.dense(listOf(daily, hourly), from, to).map { it.id })
    }

    @Test fun `limits summary reads in words`() {
        val rule = io.github.nigelleong0703.juno.contract.Rule(
            id = "r", delegation = io.github.nigelleong0703.juno.contract.Rule.Delegation(
                category = "spending", limits = io.github.nigelleong0703.juno.contract.DelegationLimits(
                    perPurchase = io.github.nigelleong0703.juno.contract.MoneyLimit("50", "USD"), perMonth = io.github.nigelleong0703.juno.contract.MoneyLimit("200", "USD"),
                ),
            ),
        )
        assertEquals("Up to \$50 each, \$200/month on Stripe", DecisionWords.limitsSummary(rule, "Stripe"))
    }
}
