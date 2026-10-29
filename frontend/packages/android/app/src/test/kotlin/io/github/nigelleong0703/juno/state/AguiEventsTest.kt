package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.AgentEvent
import io.github.nigelleong0703.juno.contract.Attachment
import io.github.nigelleong0703.juno.contract.Item
import io.github.nigelleong0703.juno.contract.Mention
import io.github.nigelleong0703.juno.contract.ResolveRequestInput
import io.github.nigelleong0703.juno.contract.RunAgentInput
import io.github.nigelleong0703.juno.ui.chat.ChatFeed
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AguiEventsTest {
    private fun apply(state: WorldState, event: String) = LiveEvents.apply(state, event)

    private fun previewState(): WorldState {
        var s = apply(WorldState(items = mapOf("c1" to emptyList())), """{"type":"${AgentEvent.TypeValue.runStarted}","threadId":"c1","runId":"wire","metadata":{"juno":{"agentId":"a1","conversationId":"c1","runId":"r1"}}}""")
        s = apply(s, """{"type":"${AgentEvent.TypeValue.textMessageStart}","messageId":"preview_t1","role":"assistant","metadata":{"juno":{"agentId":"a1","conversationId":"c1","runId":"r1","generationId":2,"seq":1}}}""")
        s = apply(s, """{"type":"${AgentEvent.TypeValue.textMessageContent}","messageId":"preview_t1","delta":"Hel","metadata":{"juno":{"agentId":"a1","conversationId":"c1","runId":"r1","generationId":2,"seq":1}}}""")
        return s
    }

    @Test fun `preview replay generation END and stop are tombstoned`() {
        var s = previewState()
        s = apply(s, """{"type":"${AgentEvent.TypeValue.textMessageContent}","messageId":"preview_t1","delta":"Hel","metadata":{"juno":{"agentId":"a1","conversationId":"c1","runId":"r1","generationId":2,"seq":1}}}""")
        s = apply(s, """{"type":"${AgentEvent.TypeValue.textMessageContent}","messageId":"preview_t1","delta":"lo","metadata":{"juno":{"agentId":"a1","conversationId":"c1","runId":"r1","generationId":2,"seq":2}}}""")
        assertEquals("Hello", s.previews.getValue("c1").getValue("r1").text)
        assertEquals("Hello", ChatFeed.transcript(s.copy(items = s.items + ("c1" to emptyList())), "c1").single().markdown)

        s = apply(s, """{"type":"${AgentEvent.TypeValue.textMessageEnd}","messageId":"preview_t1","metadata":{"juno":{"conversationId":"c1","runId":"r1","generationId":2,"seq":3}}}""")
        assertTrue(s.previews.getValue("c1").getValue("r1").closed)
        assertEquals("Hello", s.previews.getValue("c1").getValue("r1").text)

        val stopped = AguiEvents.closeRun(s, "c1", "r1")
        assertTrue(stopped.previews.getValue("c1").getValue("r1").runClosed)
        val late = apply(stopped, """{"type":"${AgentEvent.TypeValue.textMessageStart}","messageId":"preview_t2","role":"assistant","metadata":{"juno":{"agentId":"a1","conversationId":"c1","runId":"r1","generationId":3,"seq":1}}}""")
        assertEquals("preview_t1", late.previews.getValue("c1").getValue("r1").messageId)
    }

    @Test fun `authoritative text replaces preview and item added dedupes`() {
        var s = previewState()
        s = apply(s, """{"type":"${AgentEvent.TypeValue.textMessageStart}","messageId":"final","role":"assistant","metadata":{"juno":{"agentId":"a1","conversationId":"c1","runId":"r1"}}}""")
        s = apply(s, """{"type":"${AgentEvent.TypeValue.textMessageContent}","messageId":"final","delta":"Complete","metadata":{"juno":{"agentId":"a1","conversationId":"c1","runId":"r1"}}}""")
        s = apply(s, """{"type":"${AgentEvent.TypeValue.textMessageEnd}","messageId":"final","metadata":{"juno":{"agentId":"a1","conversationId":"c1","runId":"r1"}}}""")
        assertEquals("Complete", s.items.getValue("c1").single().markdown)
        assertTrue(s.previews.getValue("c1").getValue("r1").closed)
        s = apply(s, """{"type":"item.added","conversationId":"c1","item":{"id":"final","conversationId":"c1","type":"agent_message","agentId":"a1","runId":"r1","markdown":"Complete"}}""")
        assertEquals(listOf("final"), s.items.getValue("c1").map { it.id })
        assertEquals("item.added must clear a just-finished provisional bubble", "", s.previews.getValue("c1").getValue("r1").text)
    }

    @Test fun `snapshot merges rows without dropping loaded pages or outbox`() {
        val old = Item("old", at = "2026-01-01T00:00:00Z", type = "agent_message", markdown = "old")
        val local = Item("local", at = "2026-01-02T00:00:00Z", type = "user_message", text = "unsent")
        val state = WorldState(items = mapOf("c1" to listOf(old, local)), sending = setOf("local"),
            history = mapOf("c1" to ChatHistory(olderCursor = "p2")))
        val event = """{"type":"${AgentEvent.TypeValue.messagesSnapshot}","metadata":{"juno":{"conversationId":"c1"}},"messages":[{"id":"final","role":"assistant","content":"new","metadata":{"juno":{"conversationId":"c1","agentId":"a1","item":{"id":"final","conversationId":"c1","type":"agent_message","agentId":"a1","markdown":"new"}}}}]}"""
        var next = apply(state, event)
        next = apply(next, event)
        assertEquals(listOf("old", "local", "final"), next.items.getValue("c1").map { it.id })
        assertEquals(setOf("local"), next.sending)
        assertEquals("p2", next.history.getValue("c1").olderCursor)
    }

    @Test fun `composer keeps whole uploaded attachment and stable message id`() {
        val attachment = Attachment(id = "att-1", name = "photo.png", kind = "image", mimeType = "image/png")
        val mention = Mention(kind = "agent", id = "a1", label = "@Ada")
        val item = Item(id = "stable", conversationId = "c1", type = "user_message", text = "hello", attachments = listOf(attachment), mentions = listOf(mention))
        val input = junoRunInput(item, "owner")
        assertEquals("c1", input.threadId)
        val message = input.messages!!.single()
        assertEquals("stable", message.id)
        val content = message.content as JsonArray
        assertEquals("a URL-less upload cannot become an invalid standard attachment part", 1L, content.size.toLong())
        val forwarded = input.forwardedProps!!.jsonObject.getValue("juno").jsonObject.getValue("composer").jsonObject
        assertEquals("att-1", forwarded.getValue("attachments").jsonArray.single().jsonObject.getValue("id").jsonPrimitive.contentOrNull)
        assertEquals("a1", forwarded.getValue("mentions").jsonArray.single().jsonObject.getValue("id").jsonPrimitive.contentOrNull)
    }

    @Test fun `approval builder uses standard resume payload`() {
        val input = junoResumeInput("c1", "r1", "req1", "approved", ResolveRequestInput(action = "approve", scope = "once"))
        assertEquals("c1", input.threadId)
        assertEquals("req1", input.resume?.single()?.interruptId)
        assertEquals("resolved", input.resume?.single()?.status)
        assertEquals("approve", input.resume?.single()?.payload?.jsonObject?.getValue("action")?.jsonPrimitive?.contentOrNull)
    }
}
