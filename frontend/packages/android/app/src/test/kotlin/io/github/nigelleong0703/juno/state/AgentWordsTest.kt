package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.Agent
import io.github.nigelleong0703.juno.contract.Request
import io.github.nigelleong0703.juno.contract.Run
import io.github.nigelleong0703.juno.ui.chat.ChatFeed
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant

class AgentWordsTest {
    private val a1 = Agent(id = "a1", name = "Juno")

    @Test fun `doing line follows iOS order and falls back to idle`() {
        var s = WorldState(agents = listOf(a1))
        assertEquals(NOT_WORKING, s.doingLine(a1))
        s = s.copy(agents = listOf(a1.copy(lastActivity = "Wrote a note")))
        assertEquals("Wrote a note", s.doingLine(s.agents[0]))
        s = s.copy(runs = listOf(Run(id = "r1", agentId = "a1", title = "Old task", status = "completed", startedAt = "2026-01-01T00:00:00Z")))
        assertEquals("Old task", s.doingLine(s.agents[0]))
        s = s.copy(runs = s.runs + Run(id = "r2", agentId = "a1", title = "Live task", status = "running", startedAt = "2026-01-01T00:05:00Z"))
        assertEquals("Live task", s.doingLine(s.agents[0]))
        s = s.copy(doing = mapOf("a1" to "Planned line"))
        assertEquals("Planned line", s.doingLine(s.agents[0]))
    }

    @Test fun `the server's internal note never shows as a doing line`() {
        val note = "[system note, from the user's tap on a card] The user approved \"Agent directory\", which you stopped waiting for."
        val s = WorldState(
            agents = listOf(a1.copy(lastActivity = "Checked the list")),
            runs = listOf(Run(id = "r1", agentId = "a1", title = note, status = "completed", startedAt = "2026-01-01T00:00:00Z")),
        )
        assertEquals("Checked the list", s.doingLine(s.agents[0]))
        assertEquals(true, isInternalNote(note))
        assertEquals(false, isInternalNote("Summarize the [system] folder"))
    }

    @Test fun `a waiting agent says so, and a leading room mention is dropped`() {
        val s = WorldState(
            agents = listOf(a1),
            runs = listOf(Run(id = "r1", agentId = "a1", title = "@all introduce yourselves", status = "completed", startedAt = "2026-01-01T00:00:00Z")),
            requests = listOf(Request(id = "q1", status = "pending", agentId = "a1")),
        )
        assertEquals("Waiting on you", s.doingLine(s.agents[0]))
        assertEquals("introduce yourselves", withoutLeadingMentions("@all introduce yourselves"))
    }

    @Test fun `worked time counts the run's own time and leaves out a wait on a card`() {
        val run = Run(id = "r", agentId = "a1", status = "completed", startedAt = "2026-01-01T00:00:00Z", finishedAt = "2026-01-01T00:11:00Z")
        // No card: the whole run.
        assertEquals(11 * 60_000L, ChatFeed.workedMs(WorldState(runs = listOf(run)), run))
        // A card asked at 00:00:30 and answered at 00:10:30: ten minutes were the owner's, not the agent's.
        val asked = Request(id = "q", runId = "r", createdAt = "2026-01-01T00:00:30Z", resolvedAt = "2026-01-01T00:10:30Z")
        assertEquals(60_000L, ChatFeed.workedMs(WorldState(runs = listOf(run), requests = listOf(asked)), run))
        // A card still open when the run ended only counts up to the end.
        val open = Request(id = "o", runId = "r", createdAt = "2026-01-01T00:10:00Z")
        assertEquals(10 * 60_000L, ChatFeed.workedMs(WorldState(runs = listOf(run), requests = listOf(open)), run))
        // Overlapping cards are counted once: 00:00:30 to 00:11:00 is waiting, leaving 30s.
        val overlap = listOf(asked, Request(id = "p", runId = "r", createdAt = "2026-01-01T00:05:00Z", resolvedAt = "2026-01-01T00:20:00Z"))
        assertEquals(30_000L, ChatFeed.workedMs(WorldState(runs = listOf(run), requests = overlap), run))
        // Another run's card does not count.
        val other = Request(id = "x", runId = "other", createdAt = "2026-01-01T00:01:00Z", resolvedAt = "2026-01-01T00:02:00Z")
        assertEquals(11 * 60_000L, ChatFeed.workedMs(WorldState(runs = listOf(run), requests = listOf(other)), run))
    }

    @Test fun `merged intervals count each stretch once`() {
        fun iv(a: String, b: String) = Instant.parse(a) to Instant.parse(b)
        assertEquals(
            60_000L + 60_000L,
            ChatFeed.mergedMillis(listOf(iv("2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z"), iv("2026-01-01T00:02:00Z", "2026-01-01T00:03:00Z"))),
        )
        assertEquals(120_000L, ChatFeed.mergedMillis(listOf(iv("2026-01-01T00:00:00Z", "2026-01-01T00:01:30Z"), iv("2026-01-01T00:00:30Z", "2026-01-01T00:02:00Z"))))
    }

    @Test fun `footer text reads the worked time in words`() {
        val run = Run(id = "r", status = "completed")
        assertEquals("Worked 2m", ChatFeed.footerText(run, 2 * 60_000L))
        assertEquals("Worked 1s · 1 step", ChatFeed.footerText(run.copy(steps = listOf(io.github.nigelleong0703.juno.contract.Step(id = "s", index = 1, title = "x"))), 0L))
    }
}
