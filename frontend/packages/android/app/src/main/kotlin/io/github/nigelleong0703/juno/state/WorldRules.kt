package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.AuditEntry
import io.github.nigelleong0703.juno.contract.CreateRuleInput
import io.github.nigelleong0703.juno.contract.Rule
import io.github.nigelleong0703.juno.contract.Usage
import io.github.nigelleong0703.juno.contract.UpdateRuleInput
import io.github.nigelleong0703.juno.core.Api
import io.github.nigelleong0703.juno.core.ApiException
import io.github.nigelleong0703.juno.core.Page
import java.net.URLEncoder

// Auto-review rules (web data/rules.ts, client automation.ts), the audit trail and usage. Each function is one
// endpoint; the screens keep the loaded lists and reload after a change.

private fun World.rulesApi(): Api = api ?: throw ApiException.NotSignedIn

/** Built-in guardrails, the user's rules and team rules (agent drafts too); the screen filters them. */
suspend fun World.loadRules(): List<Rule> = rulesApi().list("/v1/rules?limit=200")

suspend fun World.createRule(input: CreateRuleInput) {
    rulesApi().post("/v1/rules", input)
}

suspend fun World.updateRule(id: String, patch: UpdateRuleInput) {
    rulesApi().patch("/v1/rules/$id", patch)
}

suspend fun World.deleteRule(id: String) {
    rulesApi().delete("/v1/rules/$id")
}

/** A page of the decisions agents made under rules, newest first; [unattendedOnly] keeps the work nobody was there for. */
suspend fun World.loadAudit(unattendedOnly: Boolean, cursor: String? = null): Page<AuditEntry> =
    rulesApi().page("/v1/audit?limit=$AUDIT_PAGE" + (if (unattendedOnly) "&unattended=true" else "") + (cursor?.let { "&cursor=" + URLEncoder.encode(it, "UTF-8") } ?: ""))

/** GET /v1/audit/export.csv with the same filter: the CSV text (newest first, capped by the server). */
suspend fun World.exportAuditCsv(unattendedOnly: Boolean): String =
    rulesApi().request("GET", "/v1/audit/export.csv" + if (unattendedOnly) "?unattended=true" else "")

const val AUDIT_PAGE = 20

/** This week's spend against the included limit, per agent and per app. */
suspend fun World.loadUsage(): Usage = rulesApi().get("/v1/usage")
