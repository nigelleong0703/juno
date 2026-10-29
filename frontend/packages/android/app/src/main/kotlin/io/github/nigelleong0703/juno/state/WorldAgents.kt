package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.Agent
import io.github.nigelleong0703.juno.contract.AgentTask
import io.github.nigelleong0703.juno.contract.AvatarSpec
import io.github.nigelleong0703.juno.contract.Conversation
import io.github.nigelleong0703.juno.contract.CreateAgentInput
import io.github.nigelleong0703.juno.core.ApiException
import io.github.nigelleong0703.juno.core.JunoJson
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.nowIso
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import java.util.UUID

@Serializable private class AgentEnvelope(val agent: Agent? = null)
@Serializable private class ConversationEnvelope(val conversation: Conversation? = null)
@Serializable private class CreateConversationBody(val kind: String, val memberAgentIds: List<String>, val title: String? = null, val roomMode: String? = null, val requestId: String)
@Serializable private class DirectBody(val kind: String = "direct", val memberAgentIds: List<String>)

/** GET /v1/agents/:id into the list (an agent page opened from a link or notification before the list had it). */
fun World.loadAgent(id: String) {
    val api = api ?: return
    scope.launch {
        val agent = runCatching { api.get<Agent>("/v1/agents/$id") }.getOrNull() ?: return@launch
        update { it.copy(agents = it.agents.upsert(agent) { a -> a.id }) }
    }
}

/** GET /v1/agents/:id/tasks (the live tasks whole plus the newest ended page), kept live afterwards by `task.updated`. */
fun World.loadTasks(agentId: String) {
    val api = api ?: return
    scope.launch {
        runCatching { api.page<AgentTask>("/v1/agents/$agentId/tasks") }
            .onSuccess { page ->
                update { it.copy(tasks = it.tasks + (agentId to page.items), taskNext = page.next?.let { next -> it.taskNext + (agentId to next) } ?: (it.taskNext - agentId)) }
            }
    }
}

/** The next page of older ended tasks (GET /v1/tasks?status=ended&cursor=), appended after the ones already shown. */
fun World.loadMoreTasks(agentId: String) {
    val api = api ?: return
    val cursor = state.value.taskNext[agentId] ?: return
    update { it.copy(taskNext = it.taskNext - agentId) }
    scope.launch {
        runCatching { api.page<AgentTask>("/v1/tasks?agentId=$agentId&status=ended&cursor=$cursor") }
            .onSuccess { page ->
                update { s ->
                    val known = s.taskList(agentId).map { it.id }.toSet()
                    s.copy(
                        tasks = s.tasks + (agentId to s.taskList(agentId) + page.items.filter { it.id !in known }),
                        taskNext = page.next?.let { s.taskNext + (agentId to it) } ?: s.taskNext - agentId,
                    )
                }
            }
            .onFailure { update { s -> s.copy(taskNext = s.taskNext + (agentId to cursor)) } }
    }
}

fun World.stopTask(task: AgentTask) {
    val agentId = task.agentId ?: return
    update { s ->
        val stopped = s.taskList(agentId).map { if (it.id == task.id) it.copy(status = "ended", outcome = "cancelled", outcomeDetail = "stopped_by_owner") else it }
        s.copy(tasks = s.tasks + (agentId to stopped))
    }
    remote { it.post("/v1/tasks/${task.id}/stop") }
}

fun World.stopRun(runId: String) {
    update { s ->
        val chat = s.run(runId)?.conversationId ?: s.previews.entries.firstOrNull { runId in it.value }?.key
        val stopped = s.copy(runs = s.runs.map { if (it.id == runId) it.copy(status = "stopped", finishedAt = nowIso()) else it })
        AguiEvents.closeRun(stopped, chat, runId)
    }
    remote { it.post("/v1/runs/$runId/stop") }
}

/** Creates a conversation and inserts the server result only if the signed-in session is still current. */
suspend fun World.createConversation(kind: String, memberAgentIds: List<String>, title: String?, requestId: String = UUID.randomUUID().toString()): Conversation {
    if (kind == "direct") memberAgentIds.firstOrNull()?.let { id -> state.value.directConversation(id)?.let { return it } }
    val api = api ?: throw ApiException.Http(401, "Sign in to create a conversation.")
    val raw = api.post("/v1/conversations", CreateConversationBody(kind, memberAgentIds, title, if (kind == "room") "mention" else null, requestId))
    val conversation = decodeEntity<Conversation>(raw) { JunoJson.decodeFromString<ConversationEnvelope>(it).conversation }
    if (!isCurrent(api)) throw CancellationException("session changed")
    update { s -> if (s.conversations.any { it.id == conversation.id }) s else s.copy(conversations = listOf(conversation) + s.conversations) }
    return conversation
}

/**
 * A new agent and its direct chat (POST /v1/agents, then POST /v1/conversations). An empty role is fine: the server
 * suggests one after the first few messages. Returns the chat id.
 */
suspend fun World.createAgent(name: String, role: String = "", avatar: AvatarSpec = AvatarSpec(), openChat: Boolean = true): String {
    val api = api ?: throw ApiException.Http(401, "Sign in to create an agent.")
    // Keep the required legacy avatar fields populated alongside the selected character.
    val spec = avatar.copy(shape = avatar.shape ?: "circle", color = avatar.color ?: 1, eyes = avatar.eyes ?: "dot")
    val agent = decodeEntity<Agent>(api.post("/v1/agents", CreateAgentInput(name = name, title = role.trim().ifEmpty { null }, avatar = spec))) {
        JunoJson.decodeFromString<AgentEnvelope>(it).agent
    }
    if (!isCurrent(api)) throw CancellationException("session changed")
    val chat = decodeEntity<Conversation>(api.post("/v1/conversations", DirectBody(memberAgentIds = listOf(agent.id)))) {
        JunoJson.decodeFromString<ConversationEnvelope>(it).conversation
    }
    if (!isCurrent(api)) throw CancellationException("session changed")
    update { s ->
        s.copy(agents = s.agents.upsert(agent) { it.id }, conversations = if (s.conversations.any { it.id == chat.id }) s.conversations else listOf(chat) + s.conversations)
    }
    if (openChat) openChat(chat.id)
    return chat.id
}

/**
 * Some endpoints answer with the bare object, others wrap it (`{agent: {...}}`). A bare body has an `id`; an envelope
 * does not, so try bare first and fall back, as iOS does.
 */
private inline fun <reified T : Any> decodeEntity(raw: String, envelope: (String) -> T?): T {
    val bare = runCatching { JunoJson.decodeFromString<T>(raw) }.getOrNull()
    return bare ?: envelope(raw) ?: throw ApiException.Http(500, "Unexpected server reply.")
}
