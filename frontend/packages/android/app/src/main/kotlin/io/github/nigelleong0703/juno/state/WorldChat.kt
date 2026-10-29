package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.Attachment
import io.github.nigelleong0703.juno.contract.Item
import io.github.nigelleong0703.juno.contract.Mention
import io.github.nigelleong0703.juno.contract.RunAgentInput
import io.github.nigelleong0703.juno.core.ApiException
import io.github.nigelleong0703.juno.core.JunoJson
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.nowIso
import io.github.nigelleong0703.juno.core.userMessage
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.util.UUID

@Serializable private class ComposerPayload(val text: String, val attachments: List<Attachment>? = null, val mentions: List<Mention>? = null)
@Serializable private class AcceptedRun(val item: Item? = null, val runId: String? = null)
@Serializable private class FlagPatch(val pinned: Boolean? = null, val muted: Boolean? = null)
@Serializable private class TypingBody(val active: Boolean)
@Serializable private class Transcript(val text: String = "")

/**
 * POST /v1/conversations/:id/runs with RunAgentInput. The message shows at once (marked in `sending`); a failure stays on the
 * message itself with Retry (`failed`), not in the shared sync alert.
 */
fun World.send(text: String, conversationId: String, files: List<Attachment> = emptyList(), mentions: List<Mention> = emptyList()) {
    if (api == null) return
    val localId = UUID.randomUUID().toString()
    val item = Item(
        id = localId, conversationId = conversationId, at = nowIso(), type = "user_message", authorId = state.value.selfId, text = text,
        attachments = files.ifEmpty { null }, mentions = mentions.ifEmpty { null },
    )
    update { ChatReducers.optimistic(it, item, conversationId) }
    submitComposer(item)
}

/** The stable id and whole composer survive retry; the server may acknowledge with item.added after a lost 202. */
private fun World.submitComposer(item: Item) {
    val api = api ?: return
    update { it.copy(sending = it.sending + item.id, failed = it.failed - item.id) }
    scope.launch {
        try {
            val raw = api.post("/v1/conversations/${item.conversationId}/runs", junoRunInput(item, state.value.selfId))
            if (!isCurrent(api)) return@launch
            val sent = runCatching { JunoJson.decodeFromString<AcceptedRun>(raw).item }.getOrNull()
            update { ChatReducers.confirmSent(it, item.conversationId.orEmpty(), item.id, sent) }
        } catch (e: Throwable) {
            if (!e.isCancellation && isCurrent(api)) update { ChatReducers.sendFailed(it, item.id, e.userMessage) }
        }
    }
}

internal fun junoRunInput(item: Item, authorId: String): RunAgentInput {
    val chat = item.conversationId ?: return RunAgentInput(messages = emptyList())
    val files = item.attachments.orEmpty()
    val mentions = item.mentions.orEmpty()
    val composer = ComposerPayload(item.text.orEmpty(), files.ifEmpty { null }, mentions.ifEmpty { null })
    val content = buildJsonArray {
        add(buildJsonObject { put("type", "text"); put("text", item.text.orEmpty()) })
        // Uploaded attachments without a public URL stay complete in forwardedProps; adding a URL part without
        // source would make the whole RunAgentInput invalid.
        for (file in files) {
            val url = file.url?.takeIf { it.isNotEmpty() } ?: continue
            add(buildJsonObject {
                put("type", file.kind ?: "file"); put("id", file.id)
                putJsonObject("source") {
                    put("type", "url"); put("value", url)
                    file.mimeType?.let { put("mimeType", it) }
                }
            })
        }
    }
    val metadata = buildJsonObject { putJsonObject("juno") { put("authorId", authorId); put("conversationId", chat) } }
    val message = RunAgentInput.Message(id = item.id, role = "user", metadata = metadata, content = content)
    return RunAgentInput(
        threadId = chat, runId = UUID.randomUUID().toString(), messages = listOf(message),
        forwardedProps = buildJsonObject { putJsonObject("juno") { put("composer", JunoJson.encodeToJsonElement(composer)) } },
    )
}

/** Send again a message that failed under the same stable id. */
fun World.retry(itemId: String, conversationId: String) {
    val old = state.value.items[conversationId]?.firstOrNull { it.id == itemId } ?: return
    if (old.text == null) return
    submitComposer(old)
}

fun World.discard(itemId: String, conversationId: String) = update { ChatReducers.discard(it, conversationId, itemId) }

/** POST /v1/transcriptions: the recording (AAC m4a, `audio/mp4`) in, the spoken text out. Nothing is kept server-side. */
suspend fun World.transcribe(audio: ByteArray): String {
    val api = api ?: throw ApiException.Http(401, "Sign in to dictate.")
    return JunoJson.decodeFromString<Transcript>(api.postRaw("/v1/transcriptions", audio, "audio/mp4")).text
}

/** POST /v1/conversations/:id/typing: best-effort presence, so a failure is dropped and never shown. */
fun World.reportTyping(active: Boolean, conversationId: String) {
    val api = api ?: return
    scope.launch { runCatching { api.post("/v1/conversations/$conversationId/typing", TypingBody(active)) } }
}

/** Chat-list swipe actions: pin / mute (PATCH). Local first, the server follows. */
fun World.setConversationFlag(id: String, pinned: Boolean? = null, muted: Boolean? = null) {
    update { s -> s.copy(conversations = s.conversations.map { c -> if (c.id == id) c.copy(pinned = pinned ?: c.pinned, muted = muted ?: c.muted) else c }) }
    remote { it.patch("/v1/conversations/$id", FlagPatch(pinned, muted)) }
}

fun World.markConversationRead(id: String) {
    update { s -> s.copy(conversations = s.conversations.map { c -> if (c.id == id) c.copy(unreadCount = 0) else c }) }
    remote { it.post("/v1/conversations/$id/mark-read") }
}

/**
 * An item arriving in the open chat is read as it arrives: one mark-read after a second of quiet, so a streamed
 * reply posts once rather than per item.
 */
fun World.scheduleMarkRead(id: String) {
    markReadJob?.cancel()
    markReadJob = scope.launch { delay(1000); markConversationRead(id) }
}

fun World.deleteConversation(id: String) {
    update { s -> s.copy(conversations = s.conversations.filter { it.id != id }, currentConversationId = s.currentConversationId.takeIf { it != id }) }
    remote { it.delete("/v1/conversations/$id") }
}
