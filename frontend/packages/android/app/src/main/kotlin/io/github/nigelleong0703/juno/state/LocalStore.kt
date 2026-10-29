package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.Agent
import io.github.nigelleong0703.juno.contract.Conversation
import io.github.nigelleong0703.juno.contract.Item
import io.github.nigelleong0703.juno.contract.LibraryItem
import io.github.nigelleong0703.juno.contract.Request
import io.github.nigelleong0703.juno.contract.Run
import io.github.nigelleong0703.juno.core.JunoJson
import io.github.nigelleong0703.juno.core.Session
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import java.io.File
import java.security.MessageDigest

/**
 * The on-device copy the app shows at launch (iOS Core/LocalStore.swift, as JSON files instead of SQLite): the lists
 * the screens render from and the window of each recently opened chat. The network refreshes it after each load.
 * One file per (server, user), so another account never reads it; sign-out deletes the whole directory.
 * A file that does not decode, or was written by another [VERSION], is ignored and rewritten by the next save.
 */
class LocalStore(private val root: File) {
    /** This account's snapshot, or null when there is none, it is unreadable, or its version differs. */
    @Synchronized
    fun load(session: Session): LocalSnapshot? {
        val file = fileFor(session)
        if (!file.isFile) return null
        return runCatching { JunoJson.decodeFromString<LocalSnapshot>(file.readText()) }
            .getOrNull()?.takeIf { it.version == VERSION }
    }

    /**
     * Replaces this account's snapshot. Written to a temp file and renamed, so a kill mid-write keeps the old copy.
     * [stillSignedIn] is checked under the same lock as [clear], so a save that races a sign-out never recreates the file.
     */
    @Synchronized
    fun save(session: Session, snapshot: LocalSnapshot, stillSignedIn: () -> Boolean = { true }) {
        if (!stillSignedIn()) return
        runCatching {
            root.mkdirs()
            val target = fileFor(session)
            val temp = File(root, target.name + ".tmp")
            temp.writeText(JunoJson.encodeToString(snapshot))
            if (!temp.renameTo(target)) {
                target.delete()
                temp.renameTo(target)
            }
        }
    }

    /** Sign-out: every account's file goes. */
    @Synchronized
    fun clear() {
        root.deleteRecursively()
    }

    private fun fileFor(session: Session): File {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest("${session.server.lowercase()}|${session.userId}".toByteArray())
        return File(root, "store-" + digest.take(10).joinToString("") { "%02x".format(it.toInt() and 0xff) } + ".json")
    }

    companion object {
        /** Bump when a stored shape changes incompatibly: older files are then dropped, not migrated. */
        const val VERSION = 1
    }
}

/** What [LocalStore] keeps: the lists and the chat windows, as the server returned them. */
@Serializable
data class LocalSnapshot(
    val version: Int = LocalStore.VERSION,
    val conversations: List<Conversation> = emptyList(),
    val agents: List<Agent> = emptyList(),
    val runs: List<Run> = emptyList(),
    val requests: List<Request> = emptyList(),
    val library: List<LibraryItem> = emptyList(),
    /** The open chat first, then by activity: the same 12 iOS seeds and hydrates. */
    val chats: List<LocalChat> = emptyList(),
) {
    /**
     * The state a cold start shows, before any network call. Agents still mid-work read as idle: nothing runs while the
     * app is closed, and the agent list is re-read on connect.
     */
    fun applyTo(state: WorldState): WorldState = state.copy(
        conversations = conversations,
        agents = agents.map { if (it.status == "working") it.copy(status = "idle") else it },
        runs = runs.filter { it.kind != "background" },
        requests = requests,
        library = library,
        items = state.items + chats.associate { it.conversationId to it.items },
        history = state.history + chats.associate { it.conversationId to ChatHistory(it.olderCursor, it.reachedStart) },
    )

    companion object {
        /** iOS `hydratedChats`. */
        const val CHATS = 12

        /**
         * What to keep of [state]. A chat is kept only with its history known and its window not trimmed at the newest
         * end (a detached window is not contiguous from the newest item). Messages not yet accepted by the server are left out.
         */
        fun capture(state: WorldState): LocalSnapshot {
            val unsent = state.sending + state.failed.keys
            val chats = (listOfNotNull(state.currentConversationId) + state.sortedConversations.map { it.id })
                .distinct()
                .mapNotNull { id ->
                    val items = state.items[id] ?: return@mapNotNull null
                    val history = state.history[id]?.takeIf { !it.detached } ?: return@mapNotNull null
                    LocalChat(id, history.olderCursor, history.reachedStart, items.filter { it.id !in unsent })
                }
                .take(CHATS)
            return LocalSnapshot(
                conversations = state.conversations,
                agents = state.agents,
                runs = state.runs,
                requests = state.requests,
                library = state.library,
                chats = chats,
            )
        }
    }
}

/** One chat's window, oldest first, with the cursor that pages below its oldest item. */
@Serializable
data class LocalChat(
    val conversationId: String,
    val olderCursor: String? = null,
    val reachedStart: Boolean = false,
    val items: List<Item>,
)
