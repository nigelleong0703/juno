package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.FeedPost
import io.github.nigelleong0703.juno.core.JunoJson
import io.github.nigelleong0703.juno.nav.Route
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable private class FeedbackBody(val signal: String, val reason: String? = null, val note: String? = null)

/** GET /v1/feed?limit=100: sign-in and pull-to-refresh. */
suspend fun World.reloadFeed() {
    val api = api ?: return
    val raw = runCatching { api.list<JsonElement>("/v1/feed?limit=100") }.getOrNull() ?: return
    update { it.copy(feed = raw.mapNotNull(::decodeFeedItem).newestFirst()) }
    scheduleTodayRefresh()
}

/** A post as the live stream or a feedback reply sends it: replaces the post with its id, or adds it. */
internal fun WorldState.withFeedItem(item: FeedItem): List<FeedItem> {
    val i = feed.indexOfFirst { it.post.id == item.post.id }
    return if (i >= 0) feed.toMutableList().also { it[i] = item }.newestFirst() else (feed + item).newestFirst()
}

private fun World.setFeedback(postId: String, signal: String?) =
    update { s -> s.copy(feed = s.feed.map { if (it.post.id == postId) it.copy(post = it.post.copy(feedback = signal)) else it }) }

/** POST /v1/feed/:id/feedback: "more" or "less" like this post. The local copy changes first. */
fun World.sendFeedback(postId: String, signal: String, reason: String? = null, note: String? = null) {
    setFeedback(postId, signal)
    remote { api ->
        val raw = api.post("/v1/feed/$postId/feedback", FeedbackBody(signal, reason, note))
        decodeFeedItem(JunoJson.parseToJsonElement(raw))?.let { fresh -> update { it.copy(feed = it.withFeedItem(fresh)) } }
    }
}

/** Replying to or forwarding a post says it was interesting: "more", once. */
fun World.noteInterest(post: FeedPost) {
    if (post.feedback != "more") sendFeedback(post.id, "more")
}

/** "Not for me" with a reason: the post is hidden now; the server hears "less" after the Undo window. */
fun World.dismissPost(postId: String, reason: String, note: String? = null) {
    val item = state.value.feed.firstOrNull { it.post.id == postId } ?: return
    val name = state.value.agent(item.post.agentId)?.name ?: "Your agent"
    val toast = FeedDismissal(postId, previous = item.post.feedback, reason = reason, note = note, text = "Got it. $name will adjust what it posts.")
    setFeedback(postId, "less")
    update { it.copy(feedToast = toast) }
    feature.undo.begin(toast)
}

/** Undo: the post comes back with its previous feedback, and nothing is sent. */
fun World.undoDismiss() {
    val toast = feature.undo.undo() ?: return
    update { s ->
        s.copy(feedToast = null, feed = s.feed.map { if (it.post.id == toast.postId) it.copy(post = it.post.copy(feedback = toast.previous)) else it })
    }
}

/** The window closed (or another dismissal started): tell the server; the toast clears only if it is still this one. */
internal fun World.flushFeedDismissal(toast: FeedDismissal) {
    update { if (it.feedToast?.id == toast.id) it.copy(feedToast = null) else it }
    sendFeedback(toast.postId, "less", reason = toast.reason, note = toast.note)
}

/** "Reply" on a post: the agent's direct chat opens with the post quoted in the draft. False when there is no direct chat. */
fun World.replyToPost(post: FeedPost): Boolean {
    val chat = state.value.directConversation(post.agentId ?: return false) ?: return false
    noteInterest(post)
    val quote = listOfNotNull(post.title, post.cardSummary).filter { it.isNotBlank() }.joinToString("\n") { "> $it" }
    openChat(chat.id, draft = quote)
    return true
}

/** "Forward…": title, summary and source link as one message in any chat, then a "Sent to" line for 3 s. */
fun World.forwardPost(post: FeedPost, conversationId: String) {
    val text = listOfNotNull(post.title?.let { "**$it**" }, post.cardSummary, post.sourceUrl)
        .filter { it.isNotBlank() }.joinToString("\n\n")
    noteInterest(post)
    send(text, conversationId)
    val notice = "Sent to " + (state.value.conversation(conversationId)?.let { state.value.title(it) } ?: "chat")
    update { it.copy(feedNotice = notice) }
    scope.launch {
        delay(3_000)
        update { if (it.feedNotice == notice) it.copy(feedNotice = null) else it }
    }
}

/**
 * A focus request from elsewhere in the app: the Feed page opens (pushed by the shell, unless it is already on top) and scrolls
 * to the post.
 */
fun World.focusFeedPost(postId: String) {
    update { it.copy(feedFocus = postId) }
    open(Route.Feed)
}

/** Clears the focus once it has been shown, only if nothing else asked for another post meanwhile. */
fun World.clearFeedFocus(postId: String) = update { if (it.feedFocus == postId) it.copy(feedFocus = null) else it }

/** Opens a post's page (pushed by the shell). */
fun World.openFeedPost(postId: String) = open(Route.FeedPost(postId))
