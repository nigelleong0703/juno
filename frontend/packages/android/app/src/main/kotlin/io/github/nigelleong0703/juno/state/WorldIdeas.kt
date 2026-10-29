package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.Conversation
import io.github.nigelleong0703.juno.contract.Idea
import io.github.nigelleong0703.juno.core.JunoJson

/** GET /v1/ideas?limit=200, open ones only (iOS `World+Live` sign-in load). */
suspend fun World.reloadIdeas() {
    val api = api ?: return
    val list = runCatching { api.list<Idea>("/v1/ideas?limit=200") }.getOrNull() ?: return
    update { it.copy(ideas = list.filter { idea -> idea.status == null || idea.status == "open" }) }
}

/**
 * "Do it": the server starts the idea's agent in a new chat, the idea leaves the list and that chat opens. A failed
 * accept keeps the idea so the user can try again (the failure lands in `syncError`).
 */
fun World.acceptIdea(idea: Idea) {
    remote { api ->
        val started = JunoJson.decodeFromString<Idea>(api.post("/v1/ideas/${idea.id}/accept"))
        update { s -> s.copy(ideas = s.ideas.filter { it.id != idea.id }) }
        val chat = started.conversationId ?: return@remote
        if (state.value.conversation(chat) == null) {
            val conversation = api.get<Conversation>("/v1/conversations/$chat")
            update { s -> s.copy(conversations = listOf(conversation) + s.conversations) }
        }
        openChat(chat)
    }
}

/** The draft text an idea prepared, read from the user's home by the path the idea names; null when it is gone. */
suspend fun World.ideaDraft(path: String): String? =
    runCatching { homeFiles(path).firstOrNull { it.path == path }?.content }.getOrNull()
