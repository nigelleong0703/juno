package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.AgentCalendarItem
import io.github.nigelleong0703.juno.contract.Computer
import io.github.nigelleong0703.juno.contract.Goal
import io.github.nigelleong0703.juno.contract.MacStatus
import io.github.nigelleong0703.juno.contract.Request
import io.github.nigelleong0703.juno.contract.Routine
import io.github.nigelleong0703.juno.contract.Rule
import io.github.nigelleong0703.juno.core.JunoJson
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement

/** An agent's decided requests (Permissions > History), paged by the server's cursor. */
data class Decided(val items: List<Request> = emptyList(), val next: String? = null, val loading: Boolean = false)

/** A picture as the server sent it (PNG/JPEG bytes); identity equality so a refresh always re-renders. */
class Picture(val bytes: ByteArray)

/**
 * The state of the agents features that [WorldState] does not hold: routines, goals, the calendar, computers and
 * screens, the Permissions data, channels. Kept in its own flow (see [agentsData]) so these features add no fields to
 * the shared state. Only [AgentEvents] and the `World*` extension files produce new copies.
 */
data class AgentsData(
    val routines: List<Routine> = emptyList(),
    val goals: List<Goal> = emptyList(),
    val goalsLoaded: Boolean = false,
    val calendar: List<AgentCalendarItem> = emptyList(),
    val computers: List<Computer> = emptyList(),
    val computersLoaded: Boolean = false,
    /** agentId -> screen id (GET computers/default/agents/:id/screen). */
    val screenIds: Map<String, String> = emptyMap(),
    /** agentId -> latest still of its screen. */
    val screenshots: Map<String, Picture> = emptyMap(),
    /** Library image id -> picture (task card screenshots). */
    val previews: Map<String, Picture> = emptyMap(),
    val stepsLoaded: Set<String> = emptySet(),
    val decided: Map<String, Decided> = emptyMap(),
    val grants: Map<String, List<Rule>> = emptyMap(),
    val delegations: Map<String, List<Rule>> = emptyMap(),
    val channels: Map<String, List<ChannelView>> = emptyMap(),
    val myMac: MacStatus? = null,
) {
    val computer: Computer? get() = computers.firstOrNull()
    fun routine(id: String): Routine? = routines.firstOrNull { it.id == id }
    fun goal(id: String): Goal? = goals.firstOrNull { it.id == id }
}

/** `routine.updated`, `goal.updated`, `goal.deleted` folded into [AgentsData] (iOS World+Live `apply`). Pure, so unit-tested. */
object AgentEvents {
    fun apply(data: AgentsData, event: JsonObject): AgentsData = with(LiveEvents) {
        when (event.text("type")) {
            "routine.updated" -> event.entity<Routine>("routine")?.let { data.copy(routines = data.routines.upsert(it) { r -> r.id }) } ?: data
            "goal.updated" -> event.entity<Goal>("goal")?.let { data.copy(goals = data.goals.upsert(it) { g -> g.id }) } ?: data
            "goal.deleted" -> event.text("goalId")?.let { id -> data.copy(goals = data.goals.filter { it.id != id }) } ?: data
            else -> data
        }
    }

    private inline fun <reified T> JsonObject.entity(key: String): T? =
        this[key]?.let { runCatching { JunoJson.decodeFromJsonElement<T>(it) }.getOrNull() }
}
