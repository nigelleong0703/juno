package io.github.nigelleong0703.juno.state

import kotlinx.coroutines.Job

/** Timers and debounces of the feed-side features, owned by one [World] (created lazily from its `feature` property). */
internal class FeatureRuntime(world: World) {
    val undo = FeedUndo(world.scope) { world.flushFeedDismissal(it) }
    var todayJob: Job? = null
}
