package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.Agent
import io.github.nigelleong0703.juno.contract.AgentTask
import io.github.nigelleong0703.juno.contract.Conversation
import io.github.nigelleong0703.juno.contract.Idea
import io.github.nigelleong0703.juno.contract.Item
import io.github.nigelleong0703.juno.contract.LibraryItem
import io.github.nigelleong0703.juno.contract.Request
import io.github.nigelleong0703.juno.contract.Run
import io.github.nigelleong0703.juno.contract.Space
import io.github.nigelleong0703.juno.contract.Today
import io.github.nigelleong0703.juno.core.parseIso
import io.github.nigelleong0703.juno.nav.Route
import io.github.nigelleong0703.juno.nav.Tab
import java.time.Instant

/**
 * Everything the screens render from, as one immutable value (iOS keeps these as mutable properties on `World`).
 * Read it with `val state by world.state.collectAsState()`; only [World] and [LiveEvents] produce new copies.
 * The lookup helpers mirror the iOS `World` methods of the same name.
 */
data class WorldState(
    val agents: List<Agent> = emptyList(),
    val conversations: List<Conversation> = emptyList(),
    /** Each loaded chat's window of items, oldest first. Absent = not loaded yet. */
    val items: Map<String, List<Item>> = emptyMap(),
    /** What each chat knows about the history behind its in-memory window. */
    val history: Map<String, ChatHistory> = emptyMap(),
    /** AG-UI provisional attempts per conversation and durable run; closed entries are bounded tombstones. */
    val previews: Map<String, Map<String, AguiPreview>> = emptyMap(),
    /** Authoritative TEXT_MESSAGE_* fragments until their END commits one item. */
    val streaming: Map<String, Map<String, AguiStreamingMessage>> = emptyMap(),
    /** Chats whose first page is being fetched: the transcript stays empty until it lands. */
    val itemsLoading: Set<String> = emptySet(),
    /** Items that arrived live for a chat that is not loaded yet: merged into its first page when it lands. */
    val pendingLive: Map<String, List<Item>> = emptyMap(),
    val runs: List<Run> = emptyList(),
    /** Helper runs spawned by a task (kind background, with a parent), by run id. */
    val childRuns: Map<String, Run> = emptyMap(),
    val requests: List<Request> = emptyList(),
    /** Per-agent task list (GET /v1/agents/:id/tasks, kept live by `task.updated`). */
    val tasks: Map<String, List<AgentTask>> = emptyMap(),
    /** Where the next page of older ended tasks starts, per agent (absent when there is none). */
    val taskNext: Map<String, String> = emptyMap(),
    /** What each working agent says it is doing now (`agent.status`). */
    val doing: Map<String, String> = emptyMap(),
    /** The account's user id: user_messages with this author are "mine". */
    val selfId: String = "",
    /** Live updates are connected; false while it reconnects. */
    val streamLive: Boolean = true,
    /** A failure to show once (iOS "Couldn't reach the server" alert); clear with `World.dismissSyncError`. */
    val syncError: String? = null,
    /** My messages not yet accepted by the server, by local item id. */
    val sending: Set<String> = emptySet(),
    /** Server item id -> the local id the message was shown under while it sent, so the swap keeps its list key. */
    val displayIds: Map<String, String> = emptyMap(),
    /** Local item id -> why that send failed (shown on the message, with Retry). */
    val failed: Map<String, String> = emptyMap(),
    val tab: Tab = Tab.Chat,
    val currentConversationId: String? = null,
    /** Agent filter shared by every top-level tab (null = all agents). */
    val scope: String? = null,
    /** The ☰ drawer is open (iOS `world.sidebarOpen`). */
    val sidebarOpen: Boolean = false,
    /** Text to prefill in a conversation's composer. */
    val drafts: Map<String, String> = emptyMap(),
    /** Bumped on every `agent.home.changed` event; home-file screens reload when it changes. */
    val homeRevision: Int = 0,
    /** A page asked for from outside any nav graph (a notification, a card); the shell navigates and clears it. */
    val pendingRoute: Route? = null,
    // --- Feed, Library, Ideas, Today (WorldFeed / WorldLibrary / WorldIdeas / WorldToday) ---
    /** Newest first; kept live by `feed.*` events. Hidden posts ("less") stay here: the server keeps the signal. */
    val feed: List<FeedItem> = emptyList(),
    /** The "Not for me" just pressed, with its Undo toast, until the 5 s window closes. */
    val feedToast: FeedDismissal? = null,
    /** "Not now" or "Less like this" on an idea just chosen, with Undo when it made a rule; cleared after 6 s. */
    val proactiveToast: ProactiveToast? = null,
    /** A line under the Feed header, e.g. "Sent to <chat>"; cleared after 3 s. */
    val feedNotice: String? = null,
    /** A post to scroll to and highlight (a chat's "Posted to Feed" card). */
    val feedFocus: String? = null,
    val library: List<LibraryItem> = emptyList(),
    /** Open ideas only (status nil or "open"). */
    val ideas: List<Idea> = emptyList(),
    /** GET /v1/today: the Ideas tab's suggestions come from its inspiration cards. */
    val today: Today? = null,
    /** Suggestion cards dismissed on this device; hidden at once, the server is told. */
    val dismissedInspiration: Set<String> = emptySet(),
    /** Finished runs the owner opened from Today: they leave Progress (iOS `runsSeen`). */
    val seenRuns: Set<String> = emptySet(),
    /** The Team tab's segment; Today's memory and people rows set it before they open Team (WorldTeam). */
    val teamSegment: TeamSegment = TeamSegment.Agents,
    /** The owner's Spaces (GET /v1/spaces); the Library's Shared filter lists the ones with a hosted link. */
    val spaces: List<Space> = emptyList(),
) {
    // --- Lookups ---
    fun agent(id: String?): Agent? = agents.firstOrNull { it.id == id }
    fun run(id: String?): Run? = runs.firstOrNull { it.id == id }
    fun conversation(id: String?): Conversation? = conversations.firstOrNull { it.id == id }
    fun request(id: String?): Request? = requests.firstOrNull { it.id == id }
    fun taskList(agentId: String): List<AgentTask> = tasks[agentId].orEmpty()

    /** The chat's window is ready to show. */
    fun chatLoaded(id: String): Boolean = items[id] != null && id !in itemsLoading

    /** Pinned first, then most recent. */
    val sortedConversations: List<Conversation>
        get() = conversations.sortedWith(
            compareByDescending<Conversation> { it.pinned == true }.thenByDescending { parseIso(it.lastItemAt) ?: Instant.MIN },
        )

    /** Recent chats as the sidebar and search list them: the owner's own chats, not platform groups or strangers' DMs. */
    val recentConversations: List<Conversation>
        get() = sortedConversations.filter { (it.kind == "direct" || it.kind == "room") && !it.isChannelChat }

    val defaultDirectChat: Conversation? get() = conversations.firstOrNull { it.kind == "direct" }

    fun directConversation(agentId: String): Conversation? =
        conversations.firstOrNull { it.kind == "direct" && it.agentIds == listOf(agentId) }

    fun title(c: Conversation): String {
        c.title?.takeIf { it.isNotEmpty() }?.let { return it }
        val names = c.agentIds.orEmpty().mapNotNull { agent(it)?.name }
        return if (names.isEmpty()) "Untitled chat" else names.joinToString(", ")
    }

    // --- Requests ("needs you") ---
    val pending: List<Request>
        get() = requests.filter { it.status == "pending" }.sortedByDescending { parseIso(it.createdAt) ?: Instant.MIN }

    /**
     * A question or connect card in a direct chat is the agent talking, not the owner being needed: it stays inline
     * and counts nowhere as "needs you". Approvals, sign-in, secure input and take-over still do.
     */
    fun isQuiet(r: Request): Boolean =
        (r.kind == "question" || r.kind == "connect") && conversation(r.conversationId)?.kind == "direct"

    val needsYou: List<Request> get() = pending.filter { !isQuiet(it) }
    fun needsYouIn(conversationId: String): List<Request> = needsYou.filter { it.conversationId == conversationId }
    fun needsYouOf(agentId: String): List<Request> = needsYou.filter { it.agentId == agentId }
    fun pendingIn(conversationId: String): List<Request> = pending.filter { it.conversationId == conversationId }
    fun pendingOf(agentId: String): List<Request> = pending.filter { it.agentId == agentId }

    // --- Runs ---
    fun activeRunsOf(agentId: String): List<Run> = runs.filter { it.agentId == agentId && it.status in ACTIVE_STATUSES }
    fun activeRunsIn(conversationId: String): List<Run> = runs.filter { it.conversationId == conversationId && it.status in ACTIVE_STATUSES }

    /** Reply buttons show on the latest agent turn only: once any user message follows the bubble they go. */
    fun repliesOpen(item: Item): Boolean {
        val list = items[item.conversationId] ?: return false
        val i = list.indexOfFirst { it.id == item.id }
        return i >= 0 && list.drop(i + 1).none { it.type == "user_message" }
    }

    companion object {
        val ACTIVE_STATUSES = setOf("running", "queued", "waiting_for_input", "blocked")
    }
}

/** A chat's paging state: cursor for older pages, whether the beginning is in memory, and whether the window was trimmed at its newest end. */
data class ChatHistory(
    val olderCursor: String? = null,
    val reachedStart: Boolean = false,
    val detached: Boolean = false,
    val loadingOlder: Boolean = false,
)

/** A platform chat or a stranger's DM ("Name . Slack"): out of the main list, under Groups (same rule as web chatEntries.ts). */
val Conversation.isChannelChat: Boolean get() = channel != null && (kind != "direct" || !title.isNullOrEmpty())

/** Transcript order: time, then id (the order the iOS database sorts by). */
val ItemOrder: Comparator<Item> = compareBy<Item>({ parseIso(it.at) ?: Instant.MIN }, { it.id })
