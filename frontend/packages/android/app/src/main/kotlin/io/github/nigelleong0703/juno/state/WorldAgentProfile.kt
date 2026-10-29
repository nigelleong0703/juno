package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.Agent
import io.github.nigelleong0703.juno.contract.AgentHomeFile
import io.github.nigelleong0703.juno.contract.AvatarSpec
import io.github.nigelleong0703.juno.contract.Run
import io.github.nigelleong0703.juno.contract.Step
import io.github.nigelleong0703.juno.contract.UpdateAgentInput
import io.github.nigelleong0703.juno.contract.WriteHomeFileInput
import io.github.nigelleong0703.juno.core.ApiException
import io.github.nigelleong0703.juno.core.JunoJson
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/** Steps merged by id and sorted by `index` (run lists do not carry steps on the live API). */
internal fun mergeSteps(old: List<Step>?, fetched: List<Step>): List<Step> =
    fetched.fold(old.orEmpty()) { all, s -> all.upsert(s) { it.id } }.sortedBy { it.index ?: 0 }

/** GET runs/:id/steps once per run, merged into the run (or its helper entry). */
fun World.loadSteps(runId: String) {
    val api = api ?: return
    if (runId in agentsData.value.stepsLoaded) return
    updateAgents { it.copy(stepsLoaded = it.stepsLoaded + runId) }
    scope.launch {
        val steps = runCatching { api.list<Step>("/v1/runs/$runId/steps?limit=200") }.getOrNull() ?: return@launch
        update { s ->
            when {
                s.runs.any { it.id == runId } -> s.copy(runs = s.runs.map { if (it.id == runId) it.copy(steps = mergeSteps(it.steps, steps)) else it })
                s.childRuns[runId] != null -> s.copy(childRuns = s.childRuns + (runId to s.childRuns.getValue(runId).let { it.copy(steps = mergeSteps(it.steps, steps)) }))
                else -> s
            }
        }
    }
}

/** The helper runs a task spawned, oldest first. */
fun WorldState.children(runId: String): List<Run> =
    childRuns.values.filter { it.parentRunId == runId }.sortedBy { it.startedAt.orEmpty() }

/** Fetches the helper runs the parent names (the run list leaves helpers out), then each one's steps. */
fun World.loadChildren(runId: String) {
    val api = api ?: return
    scope.launch {
        val ids = state.value.run(runId)?.childRunIds.orEmpty().filter { state.value.childRuns[it] == null }
        if (ids.isNotEmpty()) {
            runCatching { api.list<Run>("/v1/runs?ids=${ids.joinToString(",")}") }.getOrNull()?.filter { it.parentRunId != null }?.let { found ->
                update { s -> s.copy(childRuns = s.childRuns + found.associateBy { it.id }) }
            }
        }
        state.value.children(runId).forEach { loadSteps(it.id) }
    }
}

/** A run asked for by id from outside the list (a link): fetched into `runs` if the list lacks it. */
fun World.loadRun(runId: String) {
    val api = api ?: return
    if (state.value.run(runId) != null) return
    scope.launch {
        val run = runCatching { api.get<Run>("/v1/runs/$runId") }.getOrNull() ?: return@launch
        if (run.kind != "background") update { s -> s.copy(runs = s.runs.upsert(run) { it.id }) }
    }
}

/**
 * Saves the edited agent card: only name, title and avatar are sent (an empty title goes as absent), with the legacy
 * avatar fields defaulted. Local state changes only after the server accepted it (the sheet stays open on error).
 */
suspend fun World.saveAgentProfile(agentId: String, name: String, title: String, avatar: AvatarSpec?) {
    val api = api ?: throw ApiException.Http(401, "Sign in to edit this agent.")
    val trimmed = name.trim()
    if (trimmed.isEmpty()) throw ApiException.Http(400, "Enter an agent name.")
    val spec = (avatar ?: AvatarSpec()).let { it.copy(shape = it.shape ?: "circle", color = it.color ?: 1, eyes = it.eyes ?: "dot") }
    val role = title.trim().ifEmpty { null }
    api.patch("/v1/agents/$agentId", UpdateAgentInput(name = trimmed, title = role, avatar = spec))
    if (!isCurrent(api)) throw CancellationException("session changed")
    update { s -> s.copy(agents = s.agents.map { if (it.id == agentId) it.copy(name = trimmed, title = role, avatar = spec) else it }) }
}

/**
 * Pause or resume an agent (iOS `setAgentPaused`): the server answers with the agent, which replaces the local one.
 * A failure lands in [WorldState.syncError], like the other fire-and-forget calls.
 */
fun World.setAgentPaused(agentId: String, paused: Boolean) {
    val api = api ?: return
    scope.launch {
        try {
            val updated = JunoJson.decodeFromString<Agent>(api.post("/v1/agents/$agentId/${if (paused) "pause" else "resume"}"))
            if (!isCurrent(api)) return@launch
            update { s -> s.copy(agents = s.agents.map { if (it.id == agentId) updated else it }) }
        } catch (e: Throwable) {
            if (!e.isCancellation) update { it.copy(syncError = e.userMessage) }
        }
    }
}

/** Stop the agent's runs (iOS `stopAgent`): fire-and-forget; the agent's status events follow. */
fun World.stopAgent(agentId: String) = remote { it.post("/v1/agents/$agentId/stop") }


/** GET agents/:id/channels (read-only list on the Channels tab). */
fun World.loadChannels(agentId: String) {
    scope.launch {
        runCatching { refreshChannels(agentId) }
            .onSuccess { list -> updateAgents { it.copy(channels = it.channels + (agentId to list)) } }
    }
}
