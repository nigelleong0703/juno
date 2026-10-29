package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.Item
import org.junit.Assert.assertEquals
import org.junit.Test

class ChatReducersTest {
    private fun item(id: String, at: String) = Item(id, at = at, type = "user_message")

    @Test fun `newest page merges live items and keeps unsent messages at the end`() {
        val s = WorldState(
            items = mapOf("c" to listOf(item("local", "2026-01-03T00:00:00Z"))), sending = setOf("local"),
            itemsLoading = setOf("c"), pendingLive = mapOf("c" to listOf(item("live", "2026-01-02T00:00:00Z"))),
        )
        val out = ChatReducers.newestLoaded(s, "c", listOf(item("b", "2026-01-01T12:00:00Z"), item("a", "2026-01-01T00:00:00Z")), next = "cur")
        assertEquals(listOf("a", "b", "live", "local"), out.items.getValue("c").map { it.id })
        assertEquals(ChatHistory(olderCursor = "cur"), out.history["c"])
        assertEquals(emptySet<String>(), out.itemsLoading); assertEquals(emptyMap<String, List<Item>>(), out.pendingLive)
    }

    @Test fun `confirmSent swaps the optimistic item in place`() {
        val s = WorldState(items = mapOf("c" to listOf(item("x", "1"), item("local", "2"))), sending = setOf("local"))
        val out = ChatReducers.confirmSent(s, "c", "local", item("server", "2"))
        assertEquals(listOf("x", "server"), out.items.getValue("c").map { it.id })
        assertEquals("local", out.displayIds["server"]); assertEquals(emptySet<String>(), out.sending)
    }

    @Test fun `confirmSent drops the optimistic item when the live echo already arrived`() {
        val s = WorldState(items = mapOf("c" to listOf(item("local", "2"), item("server", "2"))), sending = setOf("local"))
        val out = ChatReducers.confirmSent(s, "c", "local", item("server", "2"))
        assertEquals(listOf("server"), out.items.getValue("c").map { it.id })
    }

    @Test fun `older page is prepended without duplicates and reaches the start`() {
        val s = WorldState(items = mapOf("c" to listOf(item("b", "2026-01-02T00:00:00Z"))), history = mapOf("c" to ChatHistory(olderCursor = "x", loadingOlder = true)))
        val out = ChatReducers.olderLoaded(s, "c", listOf(item("b", "2026-01-02T00:00:00Z"), item("a", "2026-01-01T00:00:00Z")), next = null)
        assertEquals(listOf("a", "b"), out.items.getValue("c").map { it.id })
        assertEquals(ChatHistory(olderCursor = null, reachedStart = true), out.history["c"])
    }

    @Test fun `sendFailed keeps the message and records why`() {
        val out = ChatReducers.sendFailed(WorldState(sending = setOf("l")), "l", "offline")
        assertEquals(mapOf("l" to "offline"), out.failed); assertEquals(emptySet<String>(), out.sending)
    }
}
