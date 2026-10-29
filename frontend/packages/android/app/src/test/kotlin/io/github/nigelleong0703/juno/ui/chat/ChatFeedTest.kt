package io.github.nigelleong0703.juno.ui.chat

import io.github.nigelleong0703.juno.contract.Item
import io.github.nigelleong0703.juno.contract.Request
import io.github.nigelleong0703.juno.contract.Run
import io.github.nigelleong0703.juno.state.ChatHistory
import io.github.nigelleong0703.juno.state.WorldState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

class ChatFeedTest {
    private val chat = "c1"
    private fun item(id: String, at: String, type: String = "agent_message", run: String? = "r1", agent: String? = "a1", extra: (Item) -> Item = { it }) =
        extra(Item(id = id, conversationId = chat, at = at, type = type, runId = run, agentId = agent, text = id))

    private fun state(items: List<Item>, runs: List<Run> = emptyList(), requests: List<Request> = emptyList()) = WorldState(
        items = mapOf(chat to items), runs = runs, requests = requests, history = mapOf(chat to ChatHistory(reachedStart = true)),
    )

    private fun entries(s: WorldState, now: String = "2026-10-22T12:00:00Z") = ChatFeed.entries(s, chat, Instant.parse(now), ZoneOffset.UTC)

    @Test fun paragraphsOfOneReplyGroupAndDaysSeparate() {
        val e = entries(state(listOf(
            item("u", "2026-10-21T10:00:00Z", "user_message", run = null, agent = null),
            item("a1", "2026-10-22T10:00:00Z"), item("a2", "2026-10-22T10:00:01Z"), item("a3", "2026-10-22T10:00:02Z"),
            item("b", "2026-10-22T10:05:00Z", run = "r2"),
        )))
        assertEquals(LocalDate.of(2026, 10, 21), e[0].dayStart)
        assertEquals(LocalDate.of(2026, 10, 22), e[1].dayStart)
        assertTrue(!e[1].continuesGroup && e[1].groupContinues)
        assertTrue(e[2].continuesGroup && e[2].groupContinues)
        assertTrue(e[3].continuesGroup && !e[3].groupContinues)
        assertTrue(!e[4].continuesGroup)
    }

    @Test fun feedRefMovesBehindLastReplyOfItsRun() {
        val moved = ChatFeed.feedRefsAfterReply(listOf(
            item("a1", "t1"), item("ref", "t2", "feed_ref"), item("a2", "t3"), item("other", "t4", "user_message", run = null),
        ))
        assertEquals(listOf("a1", "a2", "ref", "other"), moved.map { it.id })
    }

    @Test fun sentMessageKeepsItsLocalRowKey() {
        val s = state(listOf(item("server-1", "2026-10-22T10:00:00Z", "user_message", null, null))).copy(displayIds = mapOf("server-1" to "local-1"))
        assertEquals("local-1", entries(s).single().id)
    }

    @Test fun typingRowTurnsIntoTheReplyInPlace() {
        val run = Run(id = "r9", conversationId = chat, status = "running", startedAt = "2026-10-22T11:59:58Z")
        val user = item("u", "2026-10-22T11:59:57Z", "user_message", null, null)
        val typing = entries(state(listOf(user), listOf(run)))
        assertEquals("reply-r9", typing.last().id)
        assertEquals("r9", typing.last().typingRunId)
        val reply = entries(state(listOf(user, item("a", "2026-10-22T11:59:59Z", run = "r9")), listOf(run)))
        assertEquals("reply-r9", reply.last().id)
        assertNull(reply.last().typingRunId)
    }

    @Test fun workingRowAppearsAfterEightSecondsInsteadOfTheDots() {
        val run = Run(id = "r9", conversationId = chat, status = "running", startedAt = "2026-10-22T11:59:00Z")
        val e = entries(state(listOf(item("u", "2026-10-22T11:58:59Z", "user_message", null, null)), listOf(run)))
        assertEquals("status-r9", e.last().id)
        assertTrue(e.none { it.typingRunId != null })
    }

    @Test fun failedRunWithoutReplyGetsOneSyntheticRowAndPendingCardWaitsForItsRequest() {
        val failed = Run(id = "rf", conversationId = chat, status = "failed", startedAt = "2026-10-22T10:00:00Z")
        val card = item("card", "2026-10-22T10:01:00Z", "request", null, null) { it.copy(requestId = "q1") }
        val withoutRequest = entries(state(listOf(card), listOf(failed)))
        assertEquals(listOf("run-rf"), withoutRequest.map { it.id })
        val withRequest = entries(state(listOf(card), listOf(failed), listOf(Request(id = "q1", status = "approved"))))
        assertEquals(listOf("run-rf", "card"), withRequest.map { it.id })
    }

    @Test fun footerSitsUnderLastReplyOfACompletedRunThatWorked() {
        val run = Run(id = "r1", conversationId = chat, status = "completed", durationMs = 480_000)
        val plan = item("p", "t0", "plan")
        val s = state(listOf(plan, item("a1", "t1"), item("a2", "t2")), listOf(run))
        assertNull(ChatFeed.footerRun(s, s.items[chat]!![1]))
        assertEquals("r1", ChatFeed.footerRun(s, s.items[chat]!![2])?.id)
        assertEquals("Worked 8m", ChatFeed.footerText(run, ChatFeed.workedMs(s, run)))
    }

    @Test fun formatDayLabelsAndGreeting() {
        val today = LocalDate.of(2026, 10, 22)
        assertEquals("Today", ChatFormat.dayLabel(today, today))
        assertEquals("Yesterday", ChatFormat.dayLabel(today.minusDays(1), today))
        assertEquals("Still up, Robin?", ChatFormat.greeting(2, "Robin"))
        assertEquals("Good evening", ChatFormat.greeting(20, ""))
        assertEquals("1m 20s", ChatFormat.elapsed(80))
        val split = Quote.split("> hi\n> there\n\nbody")
        assertEquals("hi\nthere", split.quote)
        assertEquals("body", split.body)
    }
}
