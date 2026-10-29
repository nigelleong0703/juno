package io.github.nigelleong0703.juno.ui.chat

import io.github.nigelleong0703.juno.contract.Conversation
import io.github.nigelleong0703.juno.contract.Today
import io.github.nigelleong0703.juno.state.WorldState
import io.github.nigelleong0703.juno.state.isChannelChat

/** The filter chips of the chat list. */
sealed interface ChatFilter {
    val title: String
    data object All : ChatFilter { override val title = "All" }
    data object Unread : ChatFilter { override val title = "Unread" }
    data object NeedsYou : ChatFilter { override val title = "Needs you" }
    data object Groups : ChatFilter { override val title = "Groups" }
    data class Platform(val kind: String) : ChatFilter { override val title get() = platformName(kind) }

    companion object { val base: List<ChatFilter> = listOf(All, Unread, NeedsYou, Groups) }
}

/** What the chat list shows and in which order (spec 2.1). Pure so the filter rules are tested. */
object ChatListLogic {
    /** The platforms that have at least one conversation, in the platforms' own order. */
    fun platforms(state: WorldState): List<String> {
        val present = state.conversations.mapNotNull { it.channel?.kind }.toSet()
        return PLATFORM_KINDS.filter { it in present }
    }

    fun matches(state: WorldState, c: Conversation, filter: ChatFilter): Boolean = when (filter) {
        ChatFilter.All -> !c.isChannelChat && c.kind != "task"
        ChatFilter.Unread -> (c.unreadCount ?: 0) > 0
        ChatFilter.NeedsYou -> state.needsYouIn(c.id).isNotEmpty()
        ChatFilter.Groups -> c.channel == null && (c.kind == "room" || c.kind == "peer")
        is ChatFilter.Platform -> c.channel?.kind == filter.kind
    }

    /** Pinned first, then most recent; a platform chip whose chats are all gone behaves as All. */
    fun visible(state: WorldState, filter: ChatFilter): List<Conversation> {
        val effective = if (filter is ChatFilter.Platform && filter.kind !in platforms(state)) ChatFilter.All else filter
        return state.sortedConversations.filter { matches(state, it, effective) }
    }

    /** The second line of a row, first match wins: working, then the open ask, then the last message. */
    sealed interface Subtitle {
        data class Working(val title: String?) : Subtitle
        data class Ask(val sentence: String) : Subtitle
        data class Preview(val text: String) : Subtitle
        data object None : Subtitle
    }

    fun subtitle(state: WorldState, c: Conversation): Subtitle {
        state.activeRunsIn(c.id).firstOrNull { it.parentRunId == null && (it.status == "running" || it.status == "queued") }?.let { return Subtitle.Working(it.title) }
        state.needsYouIn(c.id).firstOrNull()?.let { return Subtitle.Ask(ChatFormat.sentence(it)) }
        return c.lastMessagePreview?.let { Subtitle.Preview(it) } ?: Subtitle.None
    }
}

/**
 * What the Today tab reads, composed from the server's `GET /v1/today` or, offline, from what the app holds (iOS
 * `TodaySummary`): the greeting's [hour], the status line's [needsYouCount], and Progress and Updates.
 */
data class TodaySummary(
    val needsYouCount: Int,
    val working: List<Working>,
    val completed: List<Completed>,
    val brief: Brief?,
    val hour: Int?,
) {
    data class Working(val agentId: String, val runId: String, val title: String)
    data class Completed(val runId: String, val agentId: String, val title: String)
    data class Brief(val summary: String, val at: String?)

    companion object {
        /** [seenRuns]: finished runs the owner already opened, hidden from Progress (iOS `World.today` filters the same way). */
        fun build(state: WorldState, remote: Today?, seenRuns: Set<String> = state.seenRuns): TodaySummary {
            if (remote == null) return composed(state)
            val top = remote.needsYou?.top.orEmpty()
            // A question or connect card in a direct chat is the agent talking, not the owner being needed (see WorldState.isQuiet).
            val quiet = { id: String? -> id?.let { state.request(it) }?.let(state::isQuiet) == true }
            return TodaySummary(
                needsYouCount = maxOf(0, (remote.needsYou?.count?.toInt() ?: 0) - top.count { quiet(it.requestId) }),
                working = remote.working.orEmpty().mapNotNull { w -> if (w.agentId != null && w.runId != null) Working(w.agentId!!, w.runId!!, w.title.orEmpty()) else null },
                completed = remote.completed.orEmpty().mapNotNull { c -> if (c.runId != null && c.agentId != null) Completed(c.runId!!, c.agentId!!, c.title.orEmpty()) else null }.filter { it.runId !in seenRuns },
                brief = remote.brief?.let { b -> b.summary?.takeIf { it.isNotEmpty() }?.let { Brief(it, b.at) } },
                hour = remote.now?.hour?.toInt(),
            )
        }

        private fun composed(state: WorldState): TodaySummary = TodaySummary(
            needsYouCount = state.needsYou.size,
            working = state.runs.filter { it.parentRunId == null && (it.status == "running" || it.status == "queued") }
                .mapNotNull { r -> r.agentId?.let { Working(it, r.id, r.title.orEmpty()) } },
            completed = emptyList(), brief = null, hour = null,
        )
    }
}
