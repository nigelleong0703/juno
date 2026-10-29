package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.Item
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage
import kotlinx.coroutines.launch
import java.net.URLEncoder

// A chat is a bounded window anchored at its newest message, with older pages prepended on demand
// (iOS World+History). There is no on-device database yet, so every cold open fetches the newest page.

/** A chat is about to be shown: fetches its newest page once; later calls are no-ops while it is loaded or loading. */
fun World.loadItems(conversationId: String) {
    if (api == null) return
    val s = state.value
    if (s.items[conversationId] != null || conversationId in s.itemsLoading) return
    update { it.copy(itemsLoading = it.itemsLoading + conversationId) }
    scope.launch { fetchNewest(conversationId) }
}

/**
 * GET the newest page (desc), make it the chat's window. Items that arrived live meanwhile are merged in, so nothing
 * between the response and now is lost.
 */
suspend fun World.fetchNewest(id: String) {
    val api = api ?: return
    update { it.copy(itemsLoading = it.itemsLoading + id) }
    try {
        val page = api.page<Item>("/v1/conversations/$id/items?order=desc&limit=${ChatReducers.PAGE_SIZE}")
        update { ChatReducers.newestLoaded(it, id, page.items, page.next) }
    } catch (e: Throwable) {
        update { it.copy(itemsLoading = it.itemsLoading - id, pendingLive = it.pendingLive - id) }
        if (!e.isCancellation && state.value.items[id] == null) update { it.copy(syncError = e.userMessage) }
    }
}

/** The reader is near the top: prepend the next older page. */
fun World.loadOlder(id: String) {
    val api = api ?: return
    val h = state.value.history[id] ?: return
    val cursor = h.olderCursor
    if (h.loadingOlder || h.reachedStart || cursor == null) return
    update { it.copy(history = it.history + (id to h.copy(loadingOlder = true))) }
    scope.launch {
        try {
            val encoded = URLEncoder.encode(cursor, "UTF-8")
            val page = api.page<Item>("/v1/conversations/$id/items?order=desc&limit=${ChatReducers.PAGE_SIZE}&cursor=$encoded")
            update { ChatReducers.olderLoaded(it, id, page.items, page.next) }
        } catch (e: Throwable) {
            update { it.copy(history = it.history + (id to (it.history[id] ?: h).copy(loadingOlder = false))) }
        }
    }
}

/** Back to the newest end after reading far back (the window was trimmed there). */
fun World.reattach(id: String) {
    if (state.value.history[id]?.detached != true) return
    update { it.copy(items = it.items - id, history = it.history - id) }
    loadItems(id)
}
