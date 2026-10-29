package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.nav.Route
import io.github.nigelleong0703.juno.nav.Tab

/**
 * The one way to open a chat from anywhere: selects the Chat tab, prefills a draft and asks the shell to navigate
 * (the shell consumes [WorldState.pendingRoute]).
 */
fun World.openChat(conversationId: String?, draft: String? = null) {
    if (conversationId == null) return
    prepareChat(conversationId, draft)
    update { it.copy(currentConversationId = conversationId, tab = Tab.Chat, pendingRoute = Route.Conversation(conversationId)) }
}

/** Prepares a conversation while the caller's nav stack owns its presentation: draft, first page, mark-read. */
fun World.prepareChat(conversationId: String, draft: String? = null) {
    if (draft != null) update { it.copy(drafts = it.drafts + (conversationId to draft)) }
    loadItems(conversationId)
    // Read on the server too: a local reset would come back on the next refetch.
    markConversationRead(conversationId)
}

/** The chat screen is no longer the current one. */
fun World.closeChat() = update { it.copy(currentConversationId = null) }

fun World.selectTab(tab: Tab) = update { it.copy(tab = tab) }

/** A page asked for from outside any nav graph (notification, card): the shell pushes it onto the current tab. */
fun World.open(route: Route) = update { it.copy(pendingRoute = route) }

/** The shell took the pending route; clear it so it does not fire again. */
fun World.consumePendingRoute() = update { it.copy(pendingRoute = null) }

/** The ☰ drawer: opened by its button, a leading-edge swipe, or a close from a sidebar row. */
fun World.setSidebarOpen(open: Boolean) = update { it.copy(sidebarOpen = open) }

/** Agent filter shared by every top-level tab (null = all agents). */
fun World.setScope(agentId: String?) = update { it.copy(scope = agentId) }

/** An agent's direct chat, else its page. */
fun World.openAgent(agentId: String) {
    val chat = state.value.directConversation(agentId)
    if (chat != null) openChat(chat.id) else open(Route.Agent(agentId))
}

/** The user saw the sync-error alert. */
fun World.dismissSyncError() = update { it.copy(syncError = null) }
