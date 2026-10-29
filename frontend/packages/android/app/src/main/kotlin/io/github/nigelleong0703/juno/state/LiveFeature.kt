package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.Idea
import io.github.nigelleong0703.juno.contract.LibraryItem
import io.github.nigelleong0703.juno.core.JunoJson
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement

/**
 * Live events of the Feed, Ideas and Library (iOS `World+Live` cases feed.*, idea.updated, artifact.updated).
 * [LiveEvents.apply] hands every type it does not handle here, so the event reducer stays one `when`.
 */
internal fun applyFeatureEvent(state: WorldState, type: String, event: JsonObject): WorldState = when (type) {
    "feed.created", "feed.updated" -> event["post"]?.let(::decodeFeedItem)?.let { state.copy(feed = state.withFeedItem(it)) } ?: state
    "idea.updated" -> {
        val idea = event["idea"]?.let { runCatching { JunoJson.decodeFromJsonElement<Idea>(it) }.getOrNull() }
        when {
            idea == null -> state
            idea.status == null || idea.status == "open" -> state.copy(ideas = state.ideas.upsert(idea) { it.id })
            else -> state.copy(ideas = state.ideas.filter { it.id != idea.id })
        }
    }
    "artifact.updated" -> {
        val item = event["artifact"]?.let { runCatching { JunoJson.decodeFromJsonElement<LibraryItem>(it) }.getOrNull() }
        item?.let { state.copy(library = state.library.upsert(it) { l -> l.id }) } ?: state
    }
    else -> state
}

/** Sign-in and reconnect: the Feed, Library and Ideas lists and Today are loaded (secondary: a failure keeps them empty). */
internal fun World.loadFeatureLists() {
    scope.launch {
        reloadFeed()
        reloadLibrary()
        reloadIdeas()
        scheduleTodayRefresh(now = true)
    }
}

/** Side effects of the feature events: the feed-brief reload and the debounced Today refresh. */
internal fun World.afterFeatureEvent(type: String?) {
    if (type == null) return
    if (type == "feed.brief") scope.launch { reloadFeed() }
    if (type.startsWith("feed.") || type.startsWith("request.") || type.startsWith("run.")) scheduleTodayRefresh()
}
