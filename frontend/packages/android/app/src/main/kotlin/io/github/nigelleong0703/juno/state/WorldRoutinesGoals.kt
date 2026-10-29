package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.AgentCalendarItem
import io.github.nigelleong0703.juno.contract.CreateGoalInput
import io.github.nigelleong0703.juno.contract.Goal
import io.github.nigelleong0703.juno.contract.GoalActivity
import io.github.nigelleong0703.juno.contract.Routine
import io.github.nigelleong0703.juno.contract.UpdateGoalInput
import io.github.nigelleong0703.juno.core.ApiException
import io.github.nigelleong0703.juno.core.JunoJson
import io.github.nigelleong0703.juno.core.nowIso
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.UUID

/** The agents features' state (routines, goals, calendar, computers, Permissions data). */
val World.agentsData: StateFlow<AgentsData> get() = agentsFlow

internal fun World.updateAgents(change: (AgentsData) -> AgentsData) = agentsFlow.update(change)

/** A routine waiting on an app does not run, whatever its enabled flag says (iOS `Routine.needsSetup`). */
val Routine.needsSetup: Boolean get() = status == "needs_setup"
/** Switch state: enabled and not waiting for setup (iOS `Routine.runs`; renamed because the contract's `runs` is the history). */
val Routine.isOn: Boolean get() = enabled == true && !needsSetup

@Serializable private class GoalEnvelope(val goal: Goal? = null)

/** Some endpoints answer with the bare object, others wrap it; a bare body has an `id`, so try that first. */
internal inline fun <reified T : Any> decodeEnvelope(raw: String, wrapped: (String) -> T?): T? =
    runCatching { JunoJson.decodeFromString<T>(raw) }.getOrNull() ?: wrapped(raw)

// --- Routines (iOS World+Agents "schedules") ---

fun World.loadRoutines() {
    val api = api ?: return
    scope.launch { runCatching { api.list<Routine>("/v1/routines?limit=200") }.onSuccess { list -> updateAgents { it.copy(routines = list) } } }
}

/** POST /v1/routines/:id/toggle. A toggle, not a set: the caller disables its switch while this is in flight (spec 5.1). */
fun World.toggleRoutine(id: String) {
    updateAgents { d -> d.copy(routines = d.routines.map { if (it.id == id) it.copy(enabled = it.enabled != true) else it }) }
    remote { it.post("/v1/routines/$id/toggle") }
}

fun World.deleteRoutine(id: String) {
    updateAgents { d -> d.copy(routines = d.routines.filter { it.id != id }) }
    remote { it.delete("/v1/routines/$id") }
}

// --- Calendar ---

private val CalendarStamp = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

/** GET /v1/calendar?from&to: the agents' own calendar items falling in [from, to). Refetched on day change. */
fun World.loadCalendar(from: Instant, to: Instant) {
    val api = api ?: return
    scope.launch {
        runCatching { api.list<AgentCalendarItem>("/v1/calendar?from=${CalendarStamp.format(from)}&to=${CalendarStamp.format(to)}") }
            .onSuccess { items -> updateAgents { it.copy(calendar = items) } }
    }
}

/** DELETE /v1/calendar/:id; the item shows cancelled at once. */
fun World.cancelCalendarItem(id: String) {
    updateAgents { d -> d.copy(calendar = d.calendar.map { if (it.id == id) it.copy(status = "cancelled") else it }) }
    remote { it.delete("/v1/calendar/$id") }
}

// --- Goals ---

fun World.loadGoals() {
    val api = api ?: return
    scope.launch {
        runCatching { api.list<Goal>("/v1/goals?limit=200") }
            // Goals with status done are not shown (iOS drops them at connect).
            .onSuccess { list -> updateAgents { it.copy(goals = list.filter { g -> g.status != "done" }, goalsLoaded = true) } }
    }
}

/** GET /v1/goals/:id: the full goal with its activity (bare or `{goal}`). */
fun World.loadGoal(id: String) {
    val api = api ?: return
    scope.launch {
        val raw = runCatching { api.request("GET", "/v1/goals/$id") }.getOrNull() ?: return@launch
        val goal = decodeEnvelope<Goal>(raw) { JunoJson.decodeFromString<GoalEnvelope>(it).goal } ?: return@launch
        updateAgents { d -> if (d.goal(id) == null) d else d.copy(goals = d.goals.map { if (it.id == id) goal else it }) }
    }
}

/** POST /v1/goals. The goal shows at once under a local id; the server's copy replaces it at the top. */
fun World.createGoal(agentId: String, kind: String, title: String, summary: String, category: String) {
    val localId = "local-" + UUID.randomUUID()
    val local = Goal(
        id = localId, status = "active", agentId = agentId, kind = kind, title = title, summary = summary, category = category,
        activity = listOf(GoalActivity(at = nowIso(), actor = "user", kind = "created", text = "Created the goal")),
    )
    updateAgents { it.copy(goals = listOf(local) + it.goals) }
    val api = api ?: return
    scope.launch {
        try {
            val raw = api.post("/v1/goals", CreateGoalInput(agentId = agentId, kind = kind, title = title, summary = summary, category = category))
            val goal = decodeEnvelope<Goal>(raw) { JunoJson.decodeFromString<GoalEnvelope>(it).goal } ?: return@launch
            updateAgents { d -> d.copy(goals = listOf(goal) + d.goals.filter { it.id != localId && it.id != goal.id }) }
        } catch (e: Throwable) {
            if (e is kotlinx.coroutines.CancellationException) return@launch
            // The server refused: take the optimistic row back out and say why.
            updateAgents { d -> d.copy(goals = d.goals.filter { it.id != localId }) }
            update { it.copy(syncError = (e as? ApiException)?.message ?: "Couldn't create the goal.") }
        }
    }
}

/** PATCH /v1/goals/:id {status}: pause or resume; the row flips at once. */
fun World.setGoalStatus(id: String, status: String) {
    updateAgents { d -> d.copy(goals = d.goals.map { if (it.id == id) it.copy(status = status) else it }) }
    remote { it.patch("/v1/goals/$id", UpdateGoalInput(status = status)) }
}

/** POST /v1/goals/:id/check ("Check now"). */
fun World.checkGoal(id: String) = remote { it.post("/v1/goals/$id/check") }
