package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.CreateRuleInput
import io.github.nigelleong0703.juno.contract.Rule
import io.github.nigelleong0703.juno.contract.RuleBehaviorValues
import io.github.nigelleong0703.juno.contract.RuleScopeValues
import io.github.nigelleong0703.juno.contract.RuleSourceValues

// The rules page's words and rules (web features/rules/RulesPage.tsx). Only `action` and `recipient` are enforced by
// the backend, so a new rule offers just those; older app/site rules still show and can be deleted.

/** The four behaviours, in the owner's words. */
val RuleBehaviors: List<Pair<String, String>> = listOf(
    RuleBehaviorValues.auto to "Act without asking",
    RuleBehaviorValues.onCommand to "Act when I say so",
    RuleBehaviorValues.ask to "Ask first",
    RuleBehaviorValues.handoff to "Hand off to me",
)

/** The scopes a new rule can have. */
val NewRuleScopes: List<Pair<String, String>> = listOf(
    RuleScopeValues.action to "Action",
    RuleScopeValues.recipient to "Recipient",
)

fun ruleBehaviorLabel(behavior: String?): String = RuleBehaviors.firstOrNull { it.first == behavior }?.second ?: behavior.orEmpty()

fun ruleScopeLabel(scope: String?): String = when (scope) {
    RuleScopeValues.app -> "App"
    RuleScopeValues.action -> "Action"
    RuleScopeValues.recipient -> "Recipient"
    RuleScopeValues.site -> "Site"
    else -> scope.orEmpty()
}

fun subjectPlaceholder(scope: String): String = when (scope) {
    RuleScopeValues.action -> "Tool name, e.g. browser.click"
    RuleScopeValues.recipient -> "Address, e.g. ana@example.com"
    else -> ""
}

/** The audit line's outcome, as the rules Activity tab words it. */
fun auditDecisionLabel(decision: String?): String = when (decision) {
    "auto_allowed" -> "Acted on its own"
    "asked" -> "Asked first"
    "approved" -> "You approved"
    "denied" -> "You denied"
    "revised" -> "You sent it back"
    "timed_out" -> "Timed out"
    "handed_off" -> "Handed off"
    else -> decision.orEmpty()
}

/** Behaviours a rule of [scope] can take: a recipient rule only ever relaxes ("act without asking" for that address). */
fun behaviorsFor(scope: String): List<Pair<String, String>> =
    if (scope == RuleScopeValues.recipient) RuleBehaviors.filter { it.first == RuleBehaviorValues.auto } else RuleBehaviors

/** Guardrails the server always enforces, shown first and never editable. */
fun builtinRules(rules: List<Rule>): List<Rule> = rules.filter { it.source == RuleSourceValues.builtin }

/** The user's own rules: not built-in, not team-agent drafts, and not delegations (those live on the agent page). */
fun customRules(rules: List<Rule>): List<Rule> = rules.filter {
    (it.source == RuleSourceValues.user || it.source == RuleSourceValues.team) && it.scope != RuleScopeValues.delegation
}

/** Filters custom rules by description or subject, ignoring case and surrounding spaces. */
fun filterRules(rules: List<Rule>, query: String): List<Rule> {
    val needle = query.trim()
    if (needle.isEmpty()) return rules
    return rules.filter {
        (it.description ?: "").contains(needle, ignoreCase = true) || (it.subject ?: "").contains(needle, ignoreCase = true)
    }
}

/** A rule being written: validated before it goes to POST /v1/rules. */
data class NewRuleDraft(
    val description: String = "",
    val scope: String = RuleScopeValues.action,
    val subject: String = "",
    val behavior: String = RuleBehaviorValues.ask,
) {
    /** Changing scope to recipient forces the only behaviour a recipient rule can have. */
    fun withScope(newScope: String): NewRuleDraft =
        copy(scope = newScope, behavior = if (newScope == RuleScopeValues.recipient) RuleBehaviorValues.auto else behavior)

    /** Null while the rule is incomplete: both the rule text and the subject are required. */
    fun toInput(): CreateRuleInput? {
        val text = description.trim()
        val subj = subject.trim()
        if (text.isEmpty() || subj.isEmpty()) return null
        return CreateRuleInput(
            description = text,
            scope = scope,
            behavior = if (scope == RuleScopeValues.recipient) RuleBehaviorValues.auto else behavior,
            enabled = true,
            subject = subj,
        )
    }
}
