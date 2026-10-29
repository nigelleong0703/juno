package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.Item

/** Pure state changes behind the chat functions of [World]: kept apart so the merge rules are testable. */
internal object ChatReducers {
    /** Page size and the in-memory window cap, as iOS `World.pageSize` / `windowCap`. */
    const val PAGE_SIZE = 40

    /**
     * The newest page landed: it becomes the chat's window, joined by items that arrived live while it was fetched
     * and by my unsent messages (the server's page does not have them yet).
     */
    fun newestLoaded(state: WorldState, chat: String, page: List<Item>, next: String?): WorldState {
        val byId = LinkedHashMap<String, Item>()
        for (item in page + state.pendingLive[chat].orEmpty()) byId[item.id] = item
        val unsent = state.items[chat].orEmpty().filter { it.id in state.sending && it.id !in byId }
        return state.copy(
            items = state.items + (chat to byId.values.sortedWith(ItemOrder) + unsent),
            pendingLive = state.pendingLive - chat,
            itemsLoading = state.itemsLoading - chat,
            history = state.history + (chat to ChatHistory(olderCursor = next, reachedStart = next == null)),
        )
    }

    /** An older page landed: prepended without duplicates; past the cap the newest end is dropped and the chat is `detached`. */
    fun olderLoaded(state: WorldState, chat: String, older: List<Item>, next: String?): WorldState {
        val have = state.items[chat].orEmpty()
        val known = have.mapTo(HashSet()) { it.id }
        var merged = older.sortedWith(ItemOrder).filter { it.id !in known } + have
        var detached = state.history[chat]?.detached == true
        if (merged.size > LiveEvents.WINDOW_CAP) { merged = merged.dropLast(merged.size - LiveEvents.WINDOW_CAP); detached = true }
        val h = state.history[chat] ?: ChatHistory()
        return state.copy(
            items = state.items + (chat to merged),
            history = state.history + (chat to h.copy(olderCursor = next, reachedStart = next == null, detached = detached, loadingOlder = false)),
        )
    }

    /** My message, shown at once and marked as sending. */
    fun optimistic(state: WorldState, item: Item, chat: String): WorldState {
        val c = state.conversations.map {
            if (it.id == chat) it.copy(lastItemAt = item.at, lastMessagePreview = item.text) else it
        }
        return state.copy(items = state.items + (chat to state.items[chat].orEmpty() + item), conversations = c, sending = state.sending + item.id)
    }

    /**
     * The server accepted [localId]: swap the optimistic item for the server's (same position), or just drop it when
     * the live echo already delivered that item, so the echo and the response never show twice.
     */
    fun confirmSent(state: WorldState, chat: String, localId: String, sent: Item?): WorldState {
        val cleared = state.copy(sending = state.sending - localId)
        val window = state.items[chat] ?: return cleared
        if (sent == null) return cleared
        val at = window.indexOfFirst { it.id == localId }
        if (at < 0) return cleared
        val next = if (sent.id != localId && window.any { it.id == sent.id }) window.filterIndexed { i, _ -> i != at }
        else window.mapIndexed { i, it -> if (i == at) sent else it }
        return cleared.copy(items = state.items + (chat to next), displayIds = state.displayIds + (sent.id to localId))
    }

    /** The send failed: the message stays, with the reason (and Retry). */
    fun sendFailed(state: WorldState, localId: String, reason: String) =
        state.copy(sending = state.sending - localId, failed = state.failed + (localId to reason))

    fun discard(state: WorldState, chat: String, itemId: String) = state.copy(
        items = state.items.mapValues { (k, v) -> if (k == chat) v.filter { it.id != itemId } else v },
        sending = state.sending - itemId, failed = state.failed - itemId,
    )
}
