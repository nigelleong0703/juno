package io.github.nigelleong0703.juno.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.isActive
import kotlinx.coroutines.job
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Request
import kotlin.coroutines.coroutineContext
import kotlin.math.min

/** One SSE event: its JSON [data] and log [id] (the resume cursor), or the server's `reset` (our cursor fell off the log). */
data class EventFrame(val id: Int?, val data: String, val isReset: Boolean = false)

/**
 * Turns SSE lines into [EventFrame]s. A frame ends at the blank line, so the caller must feed empty lines too
 * (the iOS port lost every event once by using a line API that dropped them). `id:` is the resume cursor.
 */
class SseParser(var lastId: String? = null) {
    private val data = mutableListOf<String>()
    private var event: String? = null

    /** Feeds one line (without its line break); returns a frame when that line completed one. */
    fun feed(line: String): EventFrame? {
        if (line.isEmpty()) return finishEvent()
        when {
            line.startsWith(":") -> {} // comment / keep-alive
            line.startsWith("data:") -> data += line.substring(5).trim()
            line.startsWith("id:") -> lastId = line.substring(3).trim()
            line.startsWith("event:") -> event = line.substring(6).trim()
        }
        return null
    }

    private fun finishEvent(): EventFrame? {
        val frame = when {
            event == "reset" -> { lastId = null; EventFrame(null, "", isReset = true) }
            data.isNotEmpty() -> EventFrame(lastId?.toIntOrNull(), data.joinToString("\n"))
            else -> null
        }
        data.clear(); event = null
        return frame
    }
}

/** GET /v1/events with reconnect: yields each event until the collector is cancelled; resumes with `Last-Event-ID` after a drop. */
class EventStream(
    private val session: Session,
    /** Start after this event id (GET /v1/events/cursor); null = from the start of the retained log. */
    private val after: String? = null,
    /** true once the stream is open, false when it drops (the UI shows "Reconnecting..."). */
    private val onLive: (Boolean) -> Unit = {},
) {
    fun frames(): Flow<EventFrame> = flow {
        val parser = SseParser(after)
        var backoffSeconds = 1L
        while (coroutineContext.isActive) {
            runCatching {
                val url = (session.server.trimEnd('/') + "/v1/events").toHttpUrlOrNull() ?: throw ApiException.BadServer
                val request = Request.Builder().url(url)
                    .header("Accept", "text/event-stream")
                    .header("Authorization", "Bearer ${session.token}")
                    // Presence: the server counts only known kinds (ios/web/desktop) today; harmless for others.
                    .header("x-juno-client", "android")
                    .apply { parser.lastId?.let { header("Last-Event-ID", it) } }
                    .build()
                val call = Http.streaming.newCall(request)
                val cancel = coroutineContext.job.invokeOnCompletion { call.cancel() }
                try {
                    call.execute().use { response ->
                        onLive(response.code == 200)
                        if (response.code != 200) return@use
                        val source = response.body?.source() ?: return@use
                        while (true) {
                            val line = source.readUtf8Line() ?: break
                            parser.feed(line)?.let { emit(it); backoffSeconds = 1 }
                        }
                    }
                } finally { cancel.dispose() }
            }.onFailure { if (it is kotlin.coroutines.cancellation.CancellationException) throw it }
            if (!coroutineContext.isActive) break
            onLive(false)
            delay(min(backoffSeconds, MAX_BACKOFF_SECONDS) * 1000)
            backoffSeconds *= 2
        }
    }.flowOn(Dispatchers.IO)

    private companion object { const val MAX_BACKOFF_SECONDS = 15L }
}
