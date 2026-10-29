package io.github.nigelleong0703.juno.ui.chat

import androidx.compose.runtime.Immutable
import io.github.nigelleong0703.juno.contract.Agent
import io.github.nigelleong0703.juno.contract.Item
import io.github.nigelleong0703.juno.contract.LibraryItem
import io.github.nigelleong0703.juno.contract.Request
import io.github.nigelleong0703.juno.contract.Run
import io.github.nigelleong0703.juno.state.WorldState

/**
 * What one transcript row reads from the world, looked up by the screen from its collected [WorldState]. Rows take these
 * values instead of collecting the store, so a change elsewhere (typing, another run's events) does not recompose them:
 * an equal [RowValues] lets the row skip.
 */
@Immutable
data class RowValues(
    /** The author of a user message, the agent of any other item (its avatar, name and card owner). */
    val agent: Agent? = null,
    val isSelf: Boolean = false,
    /** Why my message did not go out (or null). */
    val failed: String? = null,
    val sending: Boolean = false,
    /** The run a `run` row, a `plan` title or the live status row stands for. */
    val run: Run? = null,
    /** The finished run whose "Worked" footer sits under this reply. */
    val footerRun: Run? = null,
    /** The footer's "Worked" time (ChatFeed.workedMs), null without a footer. */
    val footerMs: Long? = null,
    val request: Request? = null,
    val requestAgentName: String? = null,
    val requestQuiet: Boolean = false,
    val library: LibraryItem? = null,
    val libraryAgentName: String? = null,
    val hidesSources: Boolean = false,
    val repliesOpen: Boolean = false,
    /** Handoff rows: "<from> handed off to <to>". */
    val handoffFrom: String = "",
    val handoffTo: String = "",
)

/** The values for one transcript row; pure, so it is unit-testable and cheap to recompute on each state change. */
fun rowValues(state: WorldState, item: Item?, statusRunId: String?): RowValues {
    if (item == null) return RowValues(run = state.run(statusRunId))
    val agent = state.agent(if (item.type == "user_message") item.authorId else item.agentId)
    val request = state.request(item.requestId)
    val library = item.artifactId?.let { id -> state.library.firstOrNull { it.id == id } }
    return RowValues(
        agent = agent,
        isSelf = item.authorId == state.selfId,
        failed = state.failed[item.id],
        sending = item.id in state.sending,
        run = state.run(item.runId),
        footerRun = ChatFeed.footerRun(state, item),
        footerMs = ChatFeed.footerRun(state, item)?.let { ChatFeed.workedMs(state, it) },
        request = request,
        requestAgentName = request?.let { state.agent(it.agentId)?.name },
        requestQuiet = request?.let { state.isQuiet(it) } ?: false,
        library = library,
        libraryAgentName = library?.let { state.agent(it.createdByAgentId)?.name },
        hidesSources = item.type == "agent_message" && ChatFeed.hidesSources(state, item),
        repliesOpen = item.type == "agent_message" && state.repliesOpen(item),
        handoffFrom = if (item.type == "handoff") state.agent(item.agentId ?: state.conversation(item.conversationId)?.agentIds?.firstOrNull())?.name ?: "An agent" else "",
        handoffTo = if (item.type == "handoff") state.agent(item.toAgentId)?.name ?: "another agent" else "",
    )
}
