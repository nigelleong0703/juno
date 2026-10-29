package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.Agent
import io.github.nigelleong0703.juno.contract.AgentTask
import io.github.nigelleong0703.juno.contract.Conversation
import io.github.nigelleong0703.juno.contract.Item
import io.github.nigelleong0703.juno.contract.Request
import io.github.nigelleong0703.juno.contract.Run
import io.github.nigelleong0703.juno.contract.Step
import io.github.nigelleong0703.juno.core.JunoJson
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement

/**
 * packages/client/src/events.ts: folds one server-sent event into the world. Pure (state in, state out) so it is
 * unit-tested; side effects (mark-read, notifications) are the caller's, see [World.applyFrame].
 *
 * AG-UI standard events are folded by [AguiEvents]; this object owns Juno product events and the shared transcript
 * merge rules (item.added, snapshot rows, paging and optimistic messages).
 */
object LiveEvents {
    /** The most items a chat keeps in memory; paging further back drops the newest end. */
    const val WINDOW_CAP = 500

    /** The event object of a raw SSE `data:` payload; null when it is not a JSON object. */
    fun parse(frame: String): JsonObject? = runCatching { JunoJson.parseToJsonElement(frame) }.getOrNull() as? JsonObject

    fun apply(state: WorldState, frame: String): WorldState = parse(frame)?.let { apply(state, it) } ?: state

    fun apply(state: WorldState, event: JsonObject): WorldState {
        val type = event.text("type") ?: return state
        if (type in AguiEvents.standardTypes) return AguiEvents.apply(state, event)
        return when (type) {
            "agent.status" -> agentStatus(state, event)
            "agent.created", "agent.updated" -> event.entity<Agent>("agent")?.let { state.copy(agents = state.agents.upsert(it) { a -> a.id }) } ?: state
            "agent.home.changed" -> state.copy(homeRevision = state.homeRevision + 1)
            "agent.deleted" -> event.text("agentId")?.let { agentDeleted(state, it) } ?: state
            "item.added" -> {
                val item = event.entity<Item>("item")
                val chat = event.text("conversationId")
                if (item != null && chat != null) {
                    val acknowledged = state.copy(sending = state.sending - item.id, failed = state.failed - item.id)
                    val next = if (item.type == "agent_message") AguiEvents.authoritativeReceived(acknowledged, item, chat) else acknowledged
                    receive(next, item, chat)
                } else state
            }
            "conversation.created", "conversation.updated" ->
                event.entity<Conversation>("conversation")?.let { state.copy(conversations = state.conversations.upsert(it) { c -> c.id }) } ?: state
            "conversation.deleted" -> event.text("conversationId")?.let { conversationDeleted(state, it) } ?: state
            "request.created", "request.resolved" ->
                event.entity<Request>("request")?.let { state.copy(requests = state.requests.upsert(it) { r -> r.id }) } ?: state
            "task.updated" -> event.entity<AgentTask>("task")?.let { applyTask(state, it) } ?: state
            else -> applyFeatureEvent(state, type, event)
        }
    }

    /**
     * An `item.added` event: into the chat's window (replacing an item that changed, e.g. a plan). While the chat's
     * first page is being fetched it is held in `pendingLive`; for a chat that is not open it is dropped (the first
     * page will include it). A chat scrolled far back (`detached`) does not take live items either.
     */
    fun receive(state: WorldState, item: Item, chat: String): WorldState {
        val window = state.items[chat]
            ?: return if (chat in state.itemsLoading) {
                state.copy(pendingLive = state.pendingLive + (chat to (state.pendingLive[chat].orEmpty().filter { it.id != item.id } + item)))
            } else state
        if (state.history[chat]?.detached == true) return state
        val at = window.indexOfFirst { it.id == item.id }
        val next = when {
            at >= 0 -> if (window[at] == item) return state else window.toMutableList().also { it[at] = item }
            else -> (window + item).let { if (it.size > WINDOW_CAP) it.drop(it.size - WINDOW_CAP) else it }
        }
        return state.copy(items = state.items + (chat to next))
    }

    /** A tasks list update: replaces the task, or puts a new one first. */
    fun applyTask(state: WorldState, task: AgentTask): WorldState {
        val agentId = task.agentId ?: return state
        val list = state.tasks[agentId].orEmpty()
        val next = if (list.any { it.id == task.id }) list.map { if (it.id == task.id) task else it } else listOf(task) + list
        return state.copy(tasks = state.tasks + (agentId to next))
    }

    private fun agentStatus(state: WorldState, event: JsonObject): WorldState {
        val id = event.text("agentId") ?: return state
        val status = event.text("status")
        val agents = state.agents.map { if (it.id == id) it.copy(status = status) else it }
        val doing = if (status == "working" && event.text("doing") != null) state.doing + (id to event.text("doing")!!) else state.doing - id
        return state.copy(agents = agents, doing = doing)
    }

    /** Everything of a deleted agent goes, not just its row: its direct chats, runs, requests and tasks. */
    private fun agentDeleted(state: WorldState, agentId: String): WorldState {
        val gone = state.conversations.filter { it.agentIds == listOf(agentId) }.map { it.id }.toSet()
        return state.copy(
            agents = state.agents.filter { it.id != agentId },
            conversations = state.conversations.filter { it.id !in gone },
            items = state.items - gone, pendingLive = state.pendingLive - gone, history = state.history - gone,
            runs = state.runs.filter { it.agentId != agentId },
            requests = state.requests.filter { it.agentId != agentId },
            tasks = state.tasks - agentId,
        )
    }

    private fun conversationDeleted(state: WorldState, id: String) = state.copy(
        conversations = state.conversations.filter { it.id != id },
        items = state.items - id, pendingLive = state.pendingLive - id, history = state.history - id,
        runs = state.runs.filter { it.conversationId != id },
        requests = state.requests.filter { it.conversationId != id },
    )

    /** Housekeeping runs (kind background) are the agent's own upkeep: only the ones a task spawned are kept, as children. */
    internal fun runChanged(state: WorldState, incoming: Run): WorldState {
        // A run event without its step list keeps the steps already received (step.added), so the footer stays.
        val run = if (incoming.steps == null) incoming.copy(steps = (state.run(incoming.id) ?: state.childRuns[incoming.id])?.steps) else incoming
        return when {
            run.kind != "background" -> state.copy(runs = state.runs.upsert(run) { it.id })
            run.parentRunId != null -> state.copy(childRuns = state.childRuns + (run.id to run))
            else -> state
        }
    }

    internal fun stepChanged(state: WorldState, runId: String?, step: Step): WorldState {
        fun merged(run: Run): Run = run.copy(steps = run.steps.orEmpty().upsert(step) { it.id })
        return when {
            state.runs.any { it.id == runId } -> state.copy(runs = state.runs.map { if (it.id == runId) merged(it) else it })
            runId != null && state.childRuns[runId] != null -> state.copy(childRuns = state.childRuns + (runId to merged(state.childRuns.getValue(runId))))
            else -> state
        }
    }

    /** A string field of an event ("type", "conversationId", ...). */
    fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

    private inline fun <reified T> JsonObject.entity(key: String): T? =
        this[key]?.let { runCatching { JunoJson.decodeFromJsonElement<T>(it) }.getOrNull() }
}

/** Replaces the element with the same id, or appends. */
fun <T> List<T>.upsert(value: T, id: (T) -> String): List<T> {
    val i = indexOfFirst { id(it) == id(value) }
    return if (i >= 0) toMutableList().also { it[i] = value } else this + value
}
