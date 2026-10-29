package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.Agent
import io.github.nigelleong0703.juno.contract.AgentTask
import io.github.nigelleong0703.juno.contract.Conversation
import io.github.nigelleong0703.juno.contract.Item
import io.github.nigelleong0703.juno.contract.Request
import io.github.nigelleong0703.juno.contract.Run
import io.github.nigelleong0703.juno.contract.Step
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class LiveEventsTest {
    private fun apply(state: WorldState, json: String) = LiveEvents.apply(state, json)

    @Test fun `unknown and malformed events change nothing`() {
        val s = WorldState(agents = listOf(Agent("a")))
        assertSame(s, apply(s, """{"type":"routine.updated"}"""))
        assertSame(s, apply(s, "not json"))
        assertSame(s, apply(s, """{"type":"agent.updated","agent":"oops"}"""))
    }

    @Test fun `agent created is added then updated in place`() {
        var s = apply(WorldState(), """{"type":"agent.created","agent":{"id":"a","name":"Ann","unknownField":1}}""")
        s = apply(s, """{"type":"agent.updated","agent":{"id":"a","name":"Anna"}}""")
        assertEquals(listOf("Anna"), s.agents.map { it.name })
    }

    @Test fun `agent status sets and clears the doing line`() {
        var s = WorldState(agents = listOf(Agent("a", status = "idle")))
        s = apply(s, """{"type":"agent.status","agentId":"a","status":"working","doing":"Booking"}""")
        assertEquals("working", s.agent("a")?.status); assertEquals("Booking", s.doing["a"])
        s = apply(s, """{"type":"agent.status","agentId":"a","status":"idle"}""")
        assertNull(s.doing["a"])
    }

    @Test fun `agent deleted removes its chats, runs, requests, tasks and items`() {
        val s = WorldState(
            agents = listOf(Agent("a"), Agent("b")),
            conversations = listOf(Conversation("c1", agentIds = listOf("a")), Conversation("c2", agentIds = listOf("a", "b"))),
            items = mapOf("c1" to listOf(Item("i"))),
            runs = listOf(Run("r1", agentId = "a"), Run("r2", agentId = "b")),
            requests = listOf(Request("q1", agentId = "a")),
            tasks = mapOf("a" to listOf(AgentTask("t", agentId = "a"))),
        )
        val out = apply(s, """{"type":"agent.deleted","agentId":"a"}""")
        assertEquals(listOf("b"), out.agents.map { it.id })
        assertEquals(listOf("c2"), out.conversations.map { it.id })
        assertEquals(emptyMap<String, List<Item>>(), out.items)
        assertEquals(listOf("r2"), out.runs.map { it.id })
        assertEquals(emptyList<Request>(), out.requests)
        assertEquals(emptyMap<String, List<AgentTask>>(), out.tasks)
    }

    @Test fun `custom run update without steps keeps the steps already received`() {
        var s = WorldState(runs = listOf(Run("r", status = "running", steps = listOf(Step("s1")))))
        s = apply(s, """{"type":"CUSTOM","name":"juno.run.updated","value":{"id":"r","status":"completed"}}""")
        assertEquals("completed", s.runs.single().status)
        assertEquals(listOf("s1"), s.runs.single().steps?.map { it.id })
    }

    @Test fun `background runs stay out of runs and only children are kept`() {
        var s = apply(WorldState(), """{"type":"CUSTOM","name":"juno.run.updated","value":{"id":"m","agentId":"a","kind":"background"}}""")
        assertEquals(emptyList<Run>(), s.runs); assertEquals(emptyMap<String, Run>(), s.childRuns)
        s = apply(s, """{"type":"CUSTOM","name":"juno.run.updated","value":{"id":"k","agentId":"a","kind":"background","parentRunId":"p"}}""")
        assertEquals(setOf("k"), s.childRuns.keys); assertEquals(emptyList<Run>(), s.runs)
    }

    @Test fun `step events merge into a run by id`() {
        var s = WorldState(runs = listOf(Run("r")))
        s = apply(s, """{"type":"STEP_STARTED","stepName":"one","metadata":{"juno":{"runId":"r","stepId":"s1"}}}""")
        s = apply(s, """{"type":"STEP_FINISHED","stepName":"two","metadata":{"juno":{"runId":"r","stepId":"s1"}}}""")
        s = apply(s, """{"type":"STEP_STARTED","stepName":"other","metadata":{"juno":{"runId":"r","stepId":"s2"}}}""")
        assertEquals(listOf("one", "other"), s.runs.single().steps?.map { it.title })
        assertEquals(listOf("completed", "running"), s.runs.single().steps?.map { it.status })
    }

    @Test fun `item added appends to a loaded chat and dedupes by id`() {
        val s0 = WorldState(items = mapOf("c" to listOf(Item("i1", at = "2026-01-01T00:00:00Z"))))
        val add = """{"type":"item.added","conversationId":"c","item":{"id":"i2","text":"hi"}}"""
        var s = apply(s0, add)
        s = apply(s, add)
        assertEquals(listOf("i1", "i2"), s.items.getValue("c").map { it.id })
        s = apply(s, """{"type":"item.added","conversationId":"c","item":{"id":"i2","text":"edited"}}""")
        assertEquals("edited", s.items.getValue("c")[1].text)
    }

    @Test fun `item added for a chat being fetched is held, for an unopened chat dropped`() {
        val add = """{"type":"item.added","conversationId":"c","item":{"id":"i"}}"""
        assertEquals(emptyMap<String, List<Item>>(), apply(WorldState(), add).pendingLive)
        val held = apply(WorldState(itemsLoading = setOf("c")), add)
        assertEquals(listOf("i"), held.pendingLive.getValue("c").map { it.id })
        assertNull(held.items["c"])
    }

    @Test fun `a detached chat does not take live items`() {
        val s = WorldState(items = mapOf("c" to listOf(Item("i1"))), history = mapOf("c" to ChatHistory(detached = true)))
        val out = apply(s, """{"type":"item.added","conversationId":"c","item":{"id":"i2"}}""")
        assertEquals(s.items, out.items)
        assertEquals(s.history, out.history)
    }

    @Test fun `the window is capped at the newest items`() {
        val full = (1..LiveEvents.WINDOW_CAP).map { Item("i$it") }
        val s = apply(WorldState(items = mapOf("c" to full)), """{"type":"item.added","conversationId":"c","item":{"id":"new"}}""")
        val list = s.items.getValue("c")
        assertEquals(LiveEvents.WINDOW_CAP, list.size); assertEquals("i2", list.first().id); assertEquals("new", list.last().id)
    }

    @Test fun `conversation deleted clears its chat, runs and requests`() {
        val s = WorldState(
            conversations = listOf(Conversation("c"), Conversation("d")), items = mapOf("c" to listOf(Item("i"))),
            runs = listOf(Run("r", conversationId = "c")), requests = listOf(Request("q", conversationId = "c")),
        )
        val out = apply(s, """{"type":"conversation.deleted","conversationId":"c"}""")
        assertEquals(listOf("d"), out.conversations.map { it.id })
        assertEquals(emptyMap<String, List<Item>>(), out.items); assertEquals(emptyList<Run>(), out.runs); assertEquals(emptyList<Request>(), out.requests)
    }

    @Test fun `request created then resolved updates one row and needsYou follows`() {
        var s = apply(WorldState(conversations = listOf(Conversation("c", kind = "room"))),
            """{"type":"request.created","request":{"id":"q","kind":"approval","status":"pending","conversationId":"c"}}""")
        assertEquals(listOf("q"), s.needsYou.map { it.id })
        s = apply(s, """{"type":"request.resolved","request":{"id":"q","kind":"approval","status":"approved","conversationId":"c"}}""")
        assertEquals(1, s.requests.size); assertEquals(emptyList<Request>(), s.needsYou)
    }

    @Test fun `a question in a direct chat is quiet`() {
        val s = apply(WorldState(conversations = listOf(Conversation("c", kind = "direct"))),
            """{"type":"request.created","request":{"id":"q","kind":"question","status":"pending","conversationId":"c"}}""")
        assertEquals(1, s.pending.size); assertEquals(emptyList<Request>(), s.needsYou)
    }

    @Test fun `task updated replaces in place or inserts first`() {
        var s = apply(WorldState(), """{"type":"task.updated","task":{"id":"t1","agentId":"a","status":"running"}}""")
        s = apply(s, """{"type":"task.updated","task":{"id":"t2","agentId":"a"}}""")
        s = apply(s, """{"type":"task.updated","task":{"id":"t1","agentId":"a","status":"ended","outcome":"failed","outcomeDetail":"timed_out","resultLine":"Timed out"}}""")
        assertEquals(listOf("t2", "t1"), s.taskList("a").map { it.id })
        assertEquals("ended", s.taskList("a")[1].status)
        assertEquals("timed_out", s.taskList("a")[1].outcomeDetail)
    }

    @Test fun `home changed bumps the revision`() {
        assertEquals(1, apply(WorldState(), """{"type":"agent.home.changed"}""").homeRevision)
    }
}
