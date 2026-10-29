package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.Item
import io.github.nigelleong0703.juno.contract.Run
import io.github.nigelleong0703.juno.contract.Step
import io.github.nigelleong0703.juno.core.JunoJson
import io.github.nigelleong0703.juno.core.nowIso
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.longOrNull
import java.time.Instant

/** Newest provisional attempt of one durable run. Closed entries remain bounded tombstones. */
data class AguiPreview(
    val conversationId: String,
    val runId: String,
    val agentId: String,
    val generationId: Long,
    val messageId: String,
    val text: String,
    val truncated: Boolean = false,
    val lastSeq: Long = 0,
    val closed: Boolean = false,
    val runClosed: Boolean = false,
    val startedAt: String,
    val retired: List<String> = emptyList(),
)

/** Authoritative text assembled from TEXT_MESSAGE_START/CONTENT and committed on END. */
data class AguiStreamingMessage(
    val conversationId: String,
    val runId: String,
    val agentId: String,
    val messageId: String,
    val text: String,
    val startedAt: String,
)

/**
 * Standard AG-UI reducer shared by chat lifecycle events. All durable identity and preview bookkeeping comes from
 * metadata.juno. Product item.added rows remain the transcript's authoritative truth and replace previews by run id.
 */
object AguiEvents {
    private val terminalRuns = setOf("completed", "failed", "stopped")
    private val settledSteps = setOf("completed", "failed", "skipped")
    private const val PREVIEW_PREFIX = "preview_"
    private const val RETIRED_KEPT = 4
    private const val TOMBSTONES_KEPT = 32
    private const val BUFFER_CAP = 32

    val standardTypes = setOf(
        "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "TEXT_MESSAGE_CHUNK",
        "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_CHUNK", "TOOL_CALL_RESULT",
        "STATE_SNAPSHOT", "STATE_DELTA", "MESSAGES_SNAPSHOT", "ACTIVITY_SNAPSHOT", "ACTIVITY_DELTA", "RAW", "CUSTOM",
        "RUN_STARTED", "RUN_FINISHED", "RUN_ERROR", "STEP_STARTED", "STEP_FINISHED",
        "REASONING_START", "REASONING_MESSAGE_START", "REASONING_MESSAGE_CONTENT", "REASONING_MESSAGE_END",
        "REASONING_MESSAGE_CHUNK", "REASONING_END", "REASONING_ENCRYPTED_VALUE",
        "SUBAGENT_STARTED", "SUBAGENT_FINISHED", "SUBAGENT_ERROR",
    )

    fun apply(state: WorldState, event: JsonObject): WorldState {
        val juno = event.juno()
        val runId = juno?.str("runId") ?: event.str("runId")
        return when (event.str("type")) {
            "RUN_STARTED" -> runStarted(state, event, juno, runId)
            "RUN_FINISHED" -> runFinished(state, event, juno, runId)
            "RUN_ERROR" -> runEnded(state, juno, runId, juno?.str("runStatus") ?: "failed", event.str("message") ?: "run failed")
            "STEP_STARTED", "STEP_FINISHED" -> step(state, event, juno, runId, event.str("type") == "STEP_FINISHED")
            "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_CHUNK", "TEXT_MESSAGE_END" -> text(state, event, juno)
            "MESSAGES_SNAPSHOT" -> snapshot(state, event)
            "CUSTOM" -> custom(state, event, juno)
            else -> state
        }
    }

    private fun runStarted(state: WorldState, event: JsonObject, juno: JsonObject?, runId: String?): WorldState {
        if (runId == null) return state
        val old = state.run(runId) ?: state.childRuns[runId]
        if (old?.status in terminalRuns) return state
        val agentId = juno?.str("agentId") ?: old?.agentId ?: return state
        val row = (old ?: Run(runId, agentId = agentId)).copy(
            agentId = agentId,
            conversationId = juno.str("conversationId") ?: event.str("threadId") ?: old?.conversationId,
            status = juno.str("runStatus") ?: "running",
        )
        return LiveEvents.runChanged(state, row)
    }

    private fun runFinished(state: WorldState, event: JsonObject, juno: JsonObject?, runId: String?): WorldState {
        val outcome = event.obj("outcome")?.str("type")
        if (outcome == "interrupt") return closeSegment(state, juno.str("conversationId"), runId)
        val status = juno.str("runStatus") ?: when (outcome) {
            "success" -> "completed"; "cancelled" -> "stopped"; else -> null
        } ?: return state
        return runEnded(state, juno, runId, status, null)
    }

    private fun runEnded(state: WorldState, juno: JsonObject?, runId: String?, status: String, error: String?): WorldState {
        if (runId == null) return state
        val old = state.run(runId) ?: state.childRuns[runId]
        val agentId = juno.str("agentId") ?: old?.agentId ?: return state
        val row = (old ?: Run(runId, agentId = agentId)).copy(
            agentId = agentId,
            conversationId = juno.str("conversationId") ?: old?.conversationId,
            status = if (old != null && old.status in terminalRuns && status !in terminalRuns) old.status else status,
            error = old?.error ?: error,
            finishedAt = old?.finishedAt ?: nowIso(),
        )
        var next = LiveEvents.runChanged(state, row)
        if (row.status in terminalRuns) next = closeRun(next, row.conversationId ?: juno.str("conversationId"), runId)
        return next
    }

    private fun step(state: WorldState, event: JsonObject, juno: JsonObject?, runId: String?, finished: Boolean): WorldState {
        val id = juno.str("stepId") ?: return state
        if (runId == null) return state
        val row = state.run(runId) ?: state.childRuns[runId] ?: return state
        val loaded = row.steps.orEmpty().firstOrNull { it.id == id }
        val merged = if (loaded != null && loaded.status in settledSteps) loaded else (loaded ?: Step(id, runId = runId, index = row.steps.orEmpty().size.toLong())).copy(
            title = loaded?.title ?: event.str("stepName") ?: id,
            status = if (finished) "completed" else "running",
        )
        return LiveEvents.stepChanged(state, runId, merged)
    }

    private fun text(state: WorldState, event: JsonObject, juno: JsonObject?): WorldState {
        val messageId = event.str("messageId") ?: return state
        return if (messageId.startsWith(PREVIEW_PREFIX)) previewText(state, event, juno, messageId)
        else committedText(state, event, juno, messageId)
    }

    private fun previewText(state: WorldState, event: JsonObject, juno: JsonObject?, messageId: String): WorldState {
        val chat = juno.str("conversationId") ?: return state
        val runId = juno.str("runId") ?: return state
        val current = state.previews[chat]?.get(runId)
        if (current?.runClosed == true || (current != null && messageId in current.retired)) return state
        if (current == null && (state.run(runId) ?: state.childRuns[runId])?.status in terminalRuns) return state
        val generation = juno.long("generationId") ?: current?.generationId ?: 0
        if (current != null && generation < current.generationId) return state
        return when (event.str("type")) {
            "TEXT_MESSAGE_START" -> {
                if (current?.messageId == messageId) return state
                val retired = (current?.retired.orEmpty() + listOfNotNull(current?.messageId)).takeLast(RETIRED_KEPT)
                put(state, chat, AguiPreview(chat, runId, juno.str("agentId") ?: current?.agentId.orEmpty(), generation,
                    messageId, "", startedAt = event.at(), retired = retired))
            }
            "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_CHUNK" -> {
                val delta = event.str("delta") ?: event.str("content") ?: return state
                if (current == null || current.messageId != messageId || current.closed) return state
                val seq = juno.long("seq") ?: return state
                if (seq <= current.lastSeq) return state
                val joined = if (event.str("type") == "TEXT_MESSAGE_CHUNK") delta else current.text + delta
                put(state, chat, current.copy(text = joined, lastSeq = seq, generationId = generation,
                    truncated = current.truncated || juno.bool("truncated") == true))
            }
            "TEXT_MESSAGE_END" -> {
                if (current == null || current.messageId != messageId) return state
                put(state, chat, current.copy(closed = true, truncated = current.truncated || juno.bool("truncated") == true,
                    lastSeq = maxOf(current.lastSeq, juno.long("seq") ?: current.lastSeq), retired = retire(current.retired, messageId)))
            }
            else -> state
        }
    }

    private fun committedText(state: WorldState, event: JsonObject, juno: JsonObject?, messageId: String): WorldState {
        val chat = juno.str("conversationId") ?: return state
        val runId = juno.str("runId") ?: return state
        if (state.items[chat].orEmpty().any { it.id == messageId }) {
            return if (event.str("type") == "TEXT_MESSAGE_END") authoritativeReceived(state, messageId, chat, juno.str("agentId"), runId) else state
        }
        val buffers = state.streaming[runId].orEmpty()
        return when (event.str("type")) {
            "TEXT_MESSAGE_START" -> {
                val held = buffers[messageId] ?: AguiStreamingMessage(chat, runId, juno.str("agentId").orEmpty(), messageId, "", event.at())
                state.copy(streaming = state.streaming + (runId to bounded(buffers, messageId, held)))
            }
            "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_CHUNK" -> {
                val held = buffers[messageId] ?: return state
                val delta = event.str("delta") ?: event.str("content") ?: return state
                val text = if (event.str("type") == "TEXT_MESSAGE_CHUNK") delta else held.text + delta
                state.copy(streaming = state.streaming + (runId to (buffers + (messageId to held.copy(text = text)))))
            }
            "TEXT_MESSAGE_END" -> {
                val held = buffers[messageId] ?: return state
                val drained = state.copy(streaming = state.streaming + (runId to (buffers - messageId)))
                val committed = if (held.text.isEmpty()) drained else LiveEvents.receive(drained, Item(id = messageId,
                    conversationId = chat, at = held.startedAt, type = "agent_message", agentId = held.agentId,
                    markdown = held.text, runId = runId), chat)
                authoritativeReceived(committed, messageId, chat, held.agentId, runId)
            }
            else -> state
        }
    }

    private fun bounded(buffers: Map<String, AguiStreamingMessage>, key: String, value: AguiStreamingMessage): Map<String, AguiStreamingMessage> {
        val out = LinkedHashMap<String, AguiStreamingMessage>()
        buffers.entries.toList().takeLast(BUFFER_CAP - 1).forEach { out[it.key] = it.value }
        out[key] = value
        return out
    }

    private fun snapshot(state: WorldState, event: JsonObject): WorldState {
        val chat = event.juno().str("conversationId") ?: event.str("threadId") ?: return state
        var next = state
        for (message in event.arr("messages").orEmpty().mapNotNull { it as? JsonObject }) {
            val meta = message.juno()
            val embedded = meta?.get("item")?.let { runCatching { JunoJson.decodeFromJsonElement<Item>(it) }.getOrNull() }
            if (embedded != null) {
                val acknowledged = next.copy(sending = next.sending - embedded.id, failed = next.failed - embedded.id)
                next = if (embedded.type == "agent_message") authoritativeReceived(acknowledged, embedded, embedded.conversationId ?: chat) else acknowledged
                next = LiveEvents.receive(next, embedded, embedded.conversationId ?: chat)
                continue
            }
            val role = message.str("role") ?: continue
            val text = message.textContent() ?: continue
            val id = message.str("id") ?: continue
            val item = when (role) {
                "assistant" -> meta.str("agentId")?.let { Item(id = id, conversationId = chat, at = event.at(), type = "agent_message",
                    agentId = it, markdown = text, runId = meta.str("runId")) }
                "user" -> meta.str("authorId")?.let { Item(id = id, conversationId = chat, at = event.at(), type = "user_message",
                    authorId = it, text = text, attachments = emptyList(), mentions = emptyList()) }
                else -> null
            }
            if (item != null) next = LiveEvents.receive(next, item, chat)
        }
        return next
    }

    private fun custom(state: WorldState, event: JsonObject, juno: JsonObject?): WorldState {
        val value = event.obj("value") ?: return state
        return when (event.str("name")) {
            "juno.run.updated" -> {
                val row = event["value"]?.let { runCatching { JunoJson.decodeFromJsonElement<Run>(it) }.getOrNull() } ?: return state
                val next = LiveEvents.runChanged(state, row)
                if (row.status in terminalRuns) closeRun(next, row.conversationId, row.id) else next
            }
            "juno.preview.closed" -> closePreview(state, value, juno)
            "juno.preview.snapshot" -> previewSnapshot(state, value)
            else -> state
        }
    }

    private fun closePreview(state: WorldState, value: JsonObject, juno: JsonObject?): WorldState {
        val runId = value.str("runId") ?: return state
        val chat = value.str("conversationId") ?: juno.str("conversationId")
            ?: state.previews.entries.firstOrNull { runId in it.value }?.key ?: return state
        val current = state.previews[chat]?.get(runId) ?: return state
        val generation = value.long("generationId")
        if (generation != null && current.generationId > generation) return state
        if (value.str("scope") != "generation" && value.str("messageId") != current.messageId) return state
        return put(state, chat, current.copy(text = "", truncated = false, closed = true, retired = retire(current.retired, current.messageId)))
    }

    private fun previewSnapshot(state: WorldState, value: JsonObject): WorldState {
        val chat = value.str("conversationId") ?: return state
        val runId = value.str("runId") ?: return state
        val messageId = value.str("messageId") ?: return state
        val text = value.str("text") ?: return state
        val current = state.previews[chat]?.get(runId)
        if (current?.runClosed == true || (current != null && messageId in current.retired)) return state
        if (current == null && (state.run(runId) ?: state.childRuns[runId])?.status in terminalRuns) return state
        val generation = value.long("generationId") ?: current?.generationId ?: 0
        if (current != null && generation < current.generationId) return state
        val seq = value.long("seq") ?: current?.lastSeq ?: 0
        if (current?.messageId == messageId && seq <= current.lastSeq) return state
        return put(state, chat, AguiPreview(chat, runId, value.str("agentId") ?: current?.agentId.orEmpty(), generation, messageId,
            text, lastSeq = seq, startedAt = current?.startedAt ?: nowIso(), retired = current?.retired.orEmpty()))
    }

    fun authoritativeReceived(state: WorldState, item: Item, chat: String): WorldState =
        authoritativeReceived(state, item.id, chat, item.agentId, item.runId)

    private fun authoritativeReceived(state: WorldState, messageId: String, chat: String, agentId: String?, runId: String?): WorldState {
        val attempts = state.previews[chat] ?: return state
        val targets = attempts.values.filter { !it.runClosed && (runId == null || it.runId == runId) && (agentId == null || it.agentId == agentId) }
        if (runId == null && targets.size != 1) return state
        var next = state
        for (target in targets) next = put(next, chat, target.copy(text = "", truncated = false, closed = true, retired = retire(target.retired, target.messageId)))
        return next
    }

    private fun closeSegment(state: WorldState, chat: String?, runId: String?): WorldState {
        if (chat == null || runId == null) return state
        val current = state.previews[chat]?.get(runId) ?: return state
        return put(state, chat, current.copy(text = "", truncated = false, closed = true, retired = retire(current.retired, current.messageId)))
    }

    /** Terminal run/stop tombstone. Inserted even when no preview was visible, so a late START cannot open one. */
    fun closeRun(state: WorldState, conversationId: String?, runId: String): WorldState {
        val chat = conversationId ?: state.previews.entries.firstOrNull { runId in it.value }?.key ?: return state
        val current = state.previews[chat]?.get(runId) ?: AguiPreview(chat, runId, state.run(runId)?.agentId.orEmpty(), -1,
            "", "", closed = true, runClosed = true, startedAt = nowIso())
        return put(state, chat, current.copy(text = "", truncated = false, closed = true, runClosed = true,
            retired = if (current.messageId.isEmpty()) current.retired else retire(current.retired, current.messageId)))
    }

    private fun put(state: WorldState, chat: String, entry: AguiPreview): WorldState {
        val runs = (state.previews[chat].orEmpty() + (entry.runId to entry)).toMutableMap()
        while (runs.size > TOMBSTONES_KEPT) {
            val oldestClosed = runs.values.filter { it.closed }.minByOrNull { it.startedAt } ?: break
            runs.remove(oldestClosed.runId)
        }
        return state.copy(previews = state.previews + (chat to runs))
    }

    private fun retire(old: List<String>, id: String): List<String> = if (id in old) old else (old + id).takeLast(RETIRED_KEPT)

    private fun JsonObject.juno(): JsonObject? = (this["metadata"] as? JsonObject)?.get("juno") as? JsonObject
    private fun JsonObject?.str(key: String): String? = (this?.get(key) as? JsonPrimitive)?.contentOrNull
    private fun JsonObject?.long(key: String): Long? = (this?.get(key) as? JsonPrimitive)?.longOrNull
    private fun JsonObject?.bool(key: String): Boolean? = (this?.get(key) as? JsonPrimitive)?.booleanOrNull
    private fun JsonObject?.obj(key: String): JsonObject? = this?.get(key) as? JsonObject
    private fun JsonObject.arr(key: String): JsonArray? = this[key] as? JsonArray
    private fun JsonObject.at(): String = (this["timestamp"] as? JsonPrimitive)?.longOrNull?.let { Instant.ofEpochMilli(it).toString() } ?: nowIso()
    private fun JsonObject.textContent(): String? = when (val content = this["content"]) {
        is JsonPrimitive -> content.contentOrNull
        is JsonArray -> content.mapNotNull { part ->
            val obj = part as? JsonObject ?: return@mapNotNull null
            if ((obj["type"] as? JsonPrimitive)?.contentOrNull != "text") null else (obj["text"] as? JsonPrimitive)?.contentOrNull
        }.joinToString("")
        else -> null
    }
}
