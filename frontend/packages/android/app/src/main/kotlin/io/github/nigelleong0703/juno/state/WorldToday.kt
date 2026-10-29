package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.Inspiration
import io.github.nigelleong0703.juno.contract.Today
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * GET /v1/today (iOS `World+Feed.scheduleTodayRefresh`). Debounced 600 ms so a burst of request/run/feed events is one
 * read. The Today tab reads it (Needs you, Progress, Updates, Ideas); the Ideas page reads its suggestions.
 */
fun World.scheduleTodayRefresh(now: Boolean = false) {
    val api = api ?: return
    feature.todayJob?.cancel()
    feature.todayJob = scope.launch {
        if (!now) delay(600)
        runCatching { api.get<Today>("/v1/today") }.onSuccess { today -> update { it.copy(today = today) } }
    }
}

/** The suggestion cards still to show: not dismissed on this device. */
val WorldState.visibleInspiration: List<Inspiration>
    get() = today?.inspiration.orEmpty().filter { it.id !in dismissedInspiration }

/** "Not interested" on a suggestion: it goes at once, and the server keeps it away. */
fun World.dismissInspiration(id: String) {
    update { it.copy(dismissedInspiration = it.dismissedInspiration + id) }
    remote { it.post("/v1/inspiration/$id/dismiss") }
}

/** Opening a finished run from Today marks it seen, so it leaves Progress (iOS `World.open(_ done:)`). */
fun World.markRunSeen(runId: String) {
    update { it.copy(seenRuns = it.seenRuns + runId) }
    remote { it.post("/v1/runs/$runId/seen") }
}
