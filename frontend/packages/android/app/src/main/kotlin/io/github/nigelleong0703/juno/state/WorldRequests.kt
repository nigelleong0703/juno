package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.DelegationDraft
import io.github.nigelleong0703.juno.contract.ResolveRequestInput
import io.github.nigelleong0703.juno.contract.ResumeEntry
import io.github.nigelleong0703.juno.contract.RunAgentInput
import io.github.nigelleong0703.juno.core.JunoJson
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.nowIso
import io.github.nigelleong0703.juno.core.userMessage
import kotlinx.coroutines.launch
import kotlinx.serialization.json.encodeToJsonElement

/**
 * decision: approved / denied / answered (UI words) -> action approve / deny / answer (API). Local first: the
 * request shows decided until the server's `request.resolved` event replaces it. An approval is "once" unless
 * [delegations] come with it (then `scope = "delegate"`); [editedDraft], [note] and [reason] ("revise") ride along.
 *
 * TODO(requests): decided history/grants and take-over; see iOS World+Requests.swift.
 */
fun World.resolve(
    requestId: String,
    decision: String,
    answers: Map<String, String>? = null,
    note: String? = null,
    scope: String = "once",
    reason: String? = null,
    editedDraft: String? = null,
    delegations: List<DelegationDraft>? = null,
) {
    val request = state.value.request(requestId) ?: return
    update { s ->
        s.copy(requests = s.requests.map {
            if (it.id != requestId) it else it.copy(
                status = decision, resolvedAt = nowIso(),
                outcome = when (decision) { "approved" -> "allowed_once"; "denied" -> if (reason == "revise") "revised" else "denied"; else -> null },
            )
        })
    }
    val action = when (decision) { "approved" -> "approve"; "answered" -> "answer"; else -> "deny" }
    val body = ResolveRequestInput(
        action = action, scope = if (action == "approve") (if (delegations != null) "delegate" else scope) else null,
        delegations = delegations, reason = reason, answers = answers, editedDraft = editedDraft, note = note?.ifEmpty { null },
    )
    // This card is already marked decided above, so `siblings` holds only the OTHER pending cards of the segment.
    val siblings = state.value.requests.filter {
        it.status == "pending" && request.runId != null && it.runId == request.runId && it.conversationId == request.conversationId
    }
    val conversationId = request.conversationId
    val runId = request.runId
    val client = api
    if (client == null || conversationId == null || runId == null || siblings.isNotEmpty()) {
        remote { it.post("/v1/requests/$requestId/resolve", body) }
        return
    }
    val input = junoResumeInput(conversationId, runId, requestId, decision, body)
    val worldScope = this.scope
    worldScope.launch {
        try {
            client.post("/v1/conversations/$conversationId/runs", input)
        } catch (e: Throwable) {
            if (!e.isCancellation && isCurrent(client)) update { s ->
                s.copy(
                    requests = s.requests.map { if (it.id == requestId && it.status == decision)
                        it.copy(status = "pending", resolvedAt = null, outcome = null) else it },
                    syncError = e.userMessage,
                )
            }
        }
    }
}

internal fun junoResumeInput(conversationId: String, runId: String, requestId: String, decision: String, body: ResolveRequestInput): RunAgentInput =
    RunAgentInput(
        threadId = conversationId, runId = runId, messages = emptyList(),
        resume = listOf(ResumeEntry(
            interruptId = requestId,
            status = if (decision == "denied") ResumeEntry.StatusValue.cancelled else ResumeEntry.StatusValue.resolved,
            payload = JunoJson.encodeToJsonElement(body),
        )),
    )

/**
 * Sends the answers of a `question` request and waits for the server, so the sheet can show per-field errors
 * ([io.github.nigelleong0703.juno.core.ApiException.Fields]) and stay open. The card flips to answered only after the server accepted them.
 */
suspend fun World.answerQuestion(requestId: String, answers: Map<String, String>) {
    api?.post("/v1/requests/$requestId/resolve", ResolveRequestInput(action = "answer", answers = answers))
    update { s ->
        s.copy(requests = s.requests.map {
            if (it.id == requestId) it.copy(status = "answered", resolvedAt = nowIso(), payload = it.payload?.copy(answers = answers)) else it
        })
    }
}
