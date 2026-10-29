package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.DelegationLimits
import io.github.nigelleong0703.juno.contract.MacStatus
import io.github.nigelleong0703.juno.contract.PermissionTiers
import io.github.nigelleong0703.juno.contract.Request
import io.github.nigelleong0703.juno.contract.Rule
import io.github.nigelleong0703.juno.contract.UpdateAgentInput
import io.github.nigelleong0703.juno.contract.UpdateDelegationInput
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage
import kotlinx.coroutines.launch

// The Permissions tab's data (iOS World+Requests "Permissions tab", World+Mac).

/** Decided requests, page 1 or the next page. A page can hold fewer rows than asked (pending ones are skipped): follow the cursor up to 6 pages until something shows. */
fun World.loadDecided(agentId: String, more: Boolean = false) {
    val api = api ?: return
    val current = agentsData.value.decided[agentId] ?: Decided()
    if (current.loading || (more && current.next == null)) return
    updateAgents { it.copy(decided = it.decided + (agentId to current.copy(loading = true))) }
    scope.launch {
        var items = if (more) current.items else emptyList()
        var next = if (more) current.next else null
        for (i in 0 until 6) {
            val path = "/v1/requests?agentId=$agentId&status=resolved&limit=15" + (next?.let { "&cursor=$it" } ?: "")
            val page = runCatching { api.page<Request>(path) }.getOrNull() ?: break
            items = items + page.items
            next = page.next
            if (page.items.isNotEmpty() || next == null) break
        }
        updateAgents { it.copy(decided = it.decided + (agentId to Decided(items, next, false))) }
    }
}

fun World.loadGrants(agentId: String) {
    val api = api ?: return
    scope.launch { runCatching { api.list<Rule>("/v1/rules?agentId=$agentId&limit=100") }.onSuccess { l -> updateAgents { it.copy(grants = it.grants + (agentId to l)) } } }
}

fun World.loadDelegations(agentId: String) {
    val api = api ?: return
    scope.launch { runCatching { api.list<Rule>("/v1/delegations?agentId=$agentId&limit=100") }.onSuccess { l -> updateAgents { it.copy(delegations = it.delegations + (agentId to l)) } } }
}

/** Older per-tool "allowed without asking" rules: never built-in ones, never delegations (spec 2.18). */
fun AgentsData.standingGrants(agentId: String): List<Rule> =
    grants[agentId].orEmpty().filter { it.behavior == "auto" && it.source != "builtin" && it.scope != "delegation" }

/** What the agent may decide alone: enabled delegations. */
fun AgentsData.delegationsOf(agentId: String): List<Rule> = delegations[agentId].orEmpty().filter { it.enabled != false }

fun World.updateDelegation(rule: Rule, limits: DelegationLimits, agentId: String) {
    updateAgents { d ->
        d.copy(delegations = d.delegations + (agentId to d.delegations[agentId].orEmpty().map { if (it.id == rule.id) it.copy(delegation = it.delegation?.copy(limits = limits)) else it }))
    }
    remote { api ->
        api.patch("/v1/delegations/${rule.id}", UpdateDelegationInput(limits = limits))
        loadDelegations(agentId)
    }
}

fun World.revokeDelegation(rule: Rule, agentId: String) {
    updateAgents { d -> d.copy(delegations = d.delegations + (agentId to d.delegations[agentId].orEmpty().filter { it.id != rule.id })) }
    remote { it.delete("/v1/delegations/${rule.id}") }
}

fun World.revokeGrant(rule: Rule, agentId: String) {
    updateAgents { d -> d.copy(grants = d.grants + (agentId to d.grants[agentId].orEmpty().filter { it.id != rule.id })) }
    remote { it.delete("/v1/rules/${rule.id}") }
}

/** PATCH agents/:id {permissionTiers}: only the changed tier is sent. */
fun World.setTier(agentId: String, change: (PermissionTiers) -> PermissionTiers) {
    val agent = state.value.agent(agentId) ?: return
    val before = agent.permissionTiers ?: PermissionTiers()
    val after = change(before)
    if (after == before) return
    val patch = change(PermissionTiers())
    update { s -> s.copy(agents = s.agents.map { if (it.id == agentId) it.copy(permissionTiers = after) else it }) }
    remote { it.patch("/v1/agents/$agentId", UpdateAgentInput(permissionTiers = patch)) }
}

/** GET computers/my-mac; a failure keeps what was known. */
fun World.refreshMyMac() {
    val api = api ?: return
    scope.launch { runCatching { api.get<MacStatus>("/v1/computers/my-mac") }.onSuccess { m -> updateAgents { it.copy(myMac = m) } } }
}

/** PATCH agents/:id {macAccess}. The switch only turns on once a Mac is paired; a server refusal puts it back and the reason shows. */
fun World.setMacAccess(agentId: String, on: Boolean) {
    val api = api ?: return
    val before = state.value.agent(agentId)?.macAccess
    if (before == on) return
    update { s -> s.copy(agents = s.agents.map { if (it.id == agentId) it.copy(macAccess = on) else it }) }
    scope.launch {
        try {
            api.patch("/v1/agents/$agentId", UpdateAgentInput(macAccess = on))
        } catch (e: Throwable) {
            if (e.isCancellation) return@launch
            update { s -> s.copy(syncError = e.userMessage, agents = s.agents.map { if (it.id == agentId) it.copy(macAccess = before) else it }) }
        }
    }
}
