package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.FeedPost
import io.github.nigelleong0703.juno.core.JunoJson
import io.github.nigelleong0703.juno.core.parseIso
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import java.util.UUID

/**
 * A feed post with its UI doc kept as raw JSON. The generated `FeedPost.ui` type drops nested block fields, so the
 * doc is parsed from [ui] by `ui/uidoc` instead.
 */
data class FeedItem(val post: FeedPost, val ui: JsonElement?)

/** A "Not for me" waiting for its Undo window: the server is told [reason] (and [note]) when the window closes. */
data class FeedDismissal(
    val postId: String,
    val previous: String?,
    val reason: String,
    val note: String?,
    val text: String,
    val id: String = UUID.randomUUID().toString(),
)

/** Decodes one feed post; a malformed post is dropped rather than failing the whole list. */
fun decodeFeedItem(raw: JsonElement): FeedItem? {
    val obj = raw as? JsonObject ?: return null
    val post = runCatching { JunoJson.decodeFromJsonElement<FeedPost>(JsonObject(obj - "ui")) }.getOrNull() ?: return null
    return FeedItem(post, obj["ui"]?.takeUnless { it is JsonNull })
}

/** Newest first, as the Feed lists them. Posts without a date sort last. */
fun List<FeedItem>.newestFirst(): List<FeedItem> =
    sortedByDescending { parseIso(it.post.createdAt) ?: java.time.Instant.MIN }

/**
 * What a post card shows as its one-line summary (iOS `FeedPost.cardSummary`): the summary, or for posts stored
 * before summaries existed, the start of the body with its markdown stripped.
 */
val FeedPost.cardSummary: String?
    get() {
        summary?.takeIf { it.isNotEmpty() }?.let { return it }
        val source = body?.takeIf { it.isNotEmpty() } ?: return null
        val text = source
            .replace(Regex("```[\\s\\S]*?```"), " ")
            .replace(Regex("!?\\[([^\\]]*)\\]\\([^)]*\\)"), "$1")
            .replace(Regex("(?m)^\\s*(#{1,6}|>|[-*•·‣])\\s+"), "")
            .replace(Regex("[*_`~]+"), "")
            .replace(Regex("\\s+"), " ")
            .trim()
        return if (text.isEmpty()) null else text.take(240)
    }
