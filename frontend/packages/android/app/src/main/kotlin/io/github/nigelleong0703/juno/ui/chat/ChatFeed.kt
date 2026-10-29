package io.github.nigelleong0703.juno.ui.chat

import io.github.nigelleong0703.juno.contract.Item
import io.github.nigelleong0703.juno.state.Fmt
import io.github.nigelleong0703.juno.contract.Run
import io.github.nigelleong0703.juno.core.parseIso
import io.github.nigelleong0703.juno.state.WorldState
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * One row of the transcript: an item, the typing row or the live status row. `id` is stable across updates (the lazy
 * list's key), so a changed row recomposes in place instead of being removed and inserted.
 */
data class ChatEntry(
    val id: String,
    val item: Item? = null,
    /** The typing row: the run it stands for. */
    val typingRunId: String? = null,
    /** The live status row at the bottom: the run it reports on. */
    val statusRunId: String? = null,
    /** Set on the first item of a day: the separator drawn above it. */
    val dayStart: LocalDate? = null,
    /** Message after the first of one agent reply (one message per paragraph): no author row, a tight gap. */
    val continuesGroup: Boolean = false,
    val groupContinues: Boolean = false,
)

/** Maps the transcript onto [ChatEntry]s (iOS `ChatFeed`) plus the run helpers it needs. Pure, so it is unit tested. */
object ChatFeed {
    const val WORK_PILL_DELAY_SECONDS = 8L

    /** The window plus a synthetic `run-<id>` row for each failed/stopped top-level run without a reply (never persisted). */
    fun transcript(state: WorldState, chat: String): List<Item> {
        if (!state.chatLoaded(chat)) return emptyList()
        val stored = state.items[chat].orEmpty()
        val live = state.previews[chat].orEmpty().values
            .filter { !it.runClosed && it.text.isNotEmpty() }
            .sortedBy { it.startedAt }
            .map { Item(id = it.messageId, conversationId = chat, at = it.startedAt, type = "agent_message", agentId = it.agentId, markdown = it.text, runId = it.runId) }
        val list = stored + live
        val referenced = list.filter { it.type == "agent_message" }.mapNotNull { it.runId }.toSet()
        // Older runs belong to history that is not in the window yet: they join when their page does.
        val windowStart = if (state.history[chat]?.reachedStart == false) parseIso(list.firstOrNull()?.at) else null
        val loose = state.runs.filter { r ->
            r.conversationId == chat && r.parentRunId == null && r.id !in referenced && r.status in setOf("failed", "stopped") &&
                (parseIso(r.startedAt) ?: Instant.MAX) >= (windowStart ?: Instant.MIN)
        }.map { Item(id = "run-${it.id}", conversationId = chat, at = it.startedAt, type = "run", runId = it.id) }
        return (list + loose).sortedBy { parseIso(it.at) ?: Instant.MIN }
    }

    fun entries(state: WorldState, chat: String, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): List<ChatEntry> {
        val items = feedRefsAfterReply(transcript(state, chat))
        val active = state.activeRunsIn(chat).filter { it.parentRunId == null }
        val run = active.firstOrNull { it.status == "running" || it.status == "queued" }
        val since = run?.let { parseIso(it.startedAt) ?: parseIso(items.lastOrNull { i -> i.type == "user_message" }?.at) ?: Instant.MIN }
        val replyIndex = since?.let { start -> items.indexOfFirst { it.type == "agent_message" && (parseIso(it.at) ?: Instant.MAX) >= start }.takeIf { it >= 0 } }
        val days = dayStarts(items, zone)

        val result = ArrayList<ChatEntry>()
        val seen = HashSet<String>()
        items.forEachIndexed { index, item ->
            if (item.type == "run" && !isFailedRunRow(state.run(item.runId))) return@forEachIndexed
            // A card whose request has not arrived joins when it does, at its final size.
            if (item.type == "request" && state.request(item.requestId) == null) return@forEachIndexed
            val id = if (index == replyIndex && run != null) "reply-${run.id}" else state.displayIds[item.id] ?: item.id
            if (!seen.add(id)) return@forEachIndexed
            var entry = ChatEntry(id, item, dayStart = days[item.id])
            val previous = result.lastOrNull()?.item
            if (entry.dayStart == null && previous != null && sameReply(previous, item)) {
                entry = entry.copy(continuesGroup = true)
                result[result.lastIndex] = result.last().copy(groupContinues = true)
            }
            result += entry
        }
        // The dots mean "working": while the run waits on a card, the card is inline and the chat shows neither.
        // A question or connect card never pauses the run, so it does not hide them.
        val waiting = state.pendingIn(chat).any { it.kind != "question" && it.kind != "connect" }
        val live = if (waiting) null else active.firstOrNull()
        val working = live?.let { showsWorkPill(state, it, now) } ?: false
        if (run != null && replyIndex == null && !waiting && !working) result += ChatEntry("reply-${run.id}", typingRunId = run.id)
        if (working && live != null) result += ChatEntry("status-${live.id}", statusRunId = live.id)
        return result
    }

    /** Two agent messages of one agent's one run: the paragraphs of a single reply. */
    private fun sameReply(a: Item, b: Item) =
        a.type == "agent_message" && b.type == "agent_message" && a.runId != null && a.runId == b.runId && a.agentId == b.agentId

    /** "Posted to Feed" cards read after the run's final reply: each `feed_ref` moves right behind the last agent message of its run. */
    fun feedRefsAfterReply(items: List<Item>): List<Item> {
        val lastReply = HashMap<String, Int>()
        items.forEachIndexed { i, it -> if (it.type == "agent_message" && it.runId != null) lastReply[it.runId!!] = i }
        val moved = HashMap<Int, MutableList<Item>>()
        val rest = ArrayList<Pair<Int, Item>>()
        items.forEachIndexed { i, it ->
            val at = if (it.type == "feed_ref") it.runId?.let { r -> lastReply[r] } else null
            if (at != null && at > i) moved.getOrPut(at) { ArrayList() } += it else rest += i to it
        }
        if (moved.isEmpty()) return items
        return rest.flatMap { (i, it) -> listOf(it) + moved[i].orEmpty() }
    }

    /** The first item of each local day, by item id. */
    fun dayStarts(items: List<Item>, zone: ZoneId): Map<String, LocalDate> {
        var last: LocalDate? = null
        val out = HashMap<String, LocalDate>()
        for (item in items) {
            val day = parseIso(item.at)?.atZone(zone)?.toLocalDate() ?: continue
            if (day != last) { out[item.id] = day; last = day }
        }
        return out
    }

    /** Runs that posted to the Feed: their replies' sources belong to the post, not the chat. */
    fun hidesSources(state: WorldState, item: Item): Boolean {
        val run = item.runId ?: return false
        val chat = item.conversationId ?: return false
        return state.items[chat].orEmpty().any { it.type == "feed_ref" && it.runId == run }
    }

    fun isFailedRunRow(run: Run?): Boolean = run != null && run.parentRunId == null && (run.status == "failed" || run.status == "stopped")

    fun stepCount(run: Run): Int? = run.steps?.let { StepText.visible(it).size }

    /** Real work, not a plain answer: a tool step, a child task or a todo plan. */
    fun didWork(state: WorldState, run: Run): Boolean {
        if ((stepCount(run) ?: 0) > 0) return true
        if (state.runs.any { it.parentRunId == run.id } || state.childRuns.values.any { it.parentRunId == run.id }) return true
        val chat = run.conversationId ?: return false
        return state.items[chat].orEmpty().any { it.type == "plan" && it.runId == run.id }
    }

    /** The finished run whose "Worked 8m" footer sits under this reply: once per run, on its last agent message. */
    fun footerRun(state: WorldState, item: Item): Run? {
        if (item.type != "agent_message") return null
        val runId = item.runId ?: return null
        val chat = item.conversationId ?: return null
        val run = state.run(runId)?.takeIf { it.status == "completed" && didWork(state, it) } ?: return null
        val last = state.items[chat].orEmpty().lastOrNull { it.type == "agent_message" && it.runId == runId }
        return run.takeIf { last?.id == item.id }
    }

    /** The live "Working…" pill: once the run has a step or plan, has gone on over 8s, or waits for the user. */
    fun showsWorkPill(state: WorldState, run: Run, now: Instant, pending: Boolean = false): Boolean {
        if (pending || didWork(state, run)) return true
        val start = parseIso(run.startedAt) ?: return false
        return now.epochSecond - start.epochSecond > WORK_PILL_DELAY_SECONDS
    }

    /**
     * iOS `Run.elapsedMs` (the server's duration, else finish minus start), less the time the run sat waiting on the owner
     * on a card. A run that resumes after a card keeps its first start, so without this the footer counted the whole
     * wait as work ("Worked 11m" on a reply that came seconds ago).
     */
    fun workedMs(state: WorldState, run: Run): Long? {
        val start = parseIso(run.startedAt)
        val end = parseIso(run.finishedAt)
        val total = run.durationMs ?: if (start != null && end != null) java.time.Duration.between(start, end).toMillis() else return null
        if (start == null || end == null) return total
        val waits = state.requests.filter { it.runId == run.id }.mapNotNull { r ->
            val from = parseIso(r.createdAt)?.coerceIn(start, end) ?: return@mapNotNull null
            val to = (parseIso(r.resolvedAt) ?: end).coerceIn(start, end)
            if (to.isAfter(from)) from to to else null
        }
        return (total - mergedMillis(waits)).coerceAtLeast(0)
    }

    /** The length of the intervals with each stretch of overlap counted once. */
    internal fun mergedMillis(intervals: List<Pair<Instant, Instant>>): Long {
        var total = 0L
        var open: Pair<Instant, Instant>? = null
        for (iv in intervals.sortedBy { it.first }) {
            val cur = open
            if (cur == null || iv.first.isAfter(cur.second)) {
                if (cur != null) total += java.time.Duration.between(cur.first, cur.second).toMillis()
                open = iv
            } else if (iv.second.isAfter(cur.second)) {
                open = cur.first to iv.second
            }
        }
        open?.let { total += java.time.Duration.between(it.first, it.second).toMillis() }
        return total
    }

    fun footerText(run: Run, workedMs: Long?): String {
        val took = workedMs?.let { " " + Fmt.duration(it) }.orEmpty()
        val n = stepCount(run) ?: 0
        return "Worked$took" + when (n) { 0 -> ""; 1 -> " · 1 step"; else -> " · $n steps" }
    }
}
