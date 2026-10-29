package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.core.nowIso
import kotlinx.serialization.Serializable

@Serializable private class TitlePatch(val title: String)

/** "Use this role" on an agent's role-suggestion card: the server takes the suggested title, an edited one follows as a profile change. */
fun World.acceptRole(agentId: String, title: String) {
    val suggestion = state.value.agent(agentId)?.roleSuggestion ?: return
    val edited = title.trim()
    update { s -> s.copy(agents = s.agents.map { if (it.id == agentId) it.copy(title = edited.ifEmpty { suggestion.title }, roleSuggestion = null) else it }) }
    remote { api ->
        api.post("/v1/agents/$agentId/role-suggestion/accept")
        if (edited.isNotEmpty() && edited != suggestion.title) api.patch("/v1/agents/$agentId", TitlePatch(edited))
    }
}

/** "Not now": the server forgets the suggestion and does not suggest again for this agent. */
fun World.dismissRole(agentId: String) {
    update { s -> s.copy(agents = s.agents.map { if (it.id == agentId) it.copy(roleSuggestion = null, roleSuggestionDismissedAt = nowIso()) else it }) }
    remote { it.post("/v1/agents/$agentId/role-suggestion/dismiss") }
}
