package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.core.JunoJson
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import java.util.UUID

/** One thing the person told Juno about what is worth interrupting them for (GET /v1/proactive/rules). */
@Serializable
data class ProactiveRule(
    val id: String,
    /** "tell", "dont", "less" or "where". */
    val kind: String,
    val scope: String,
    val strength: String? = null,
    val text: String,
    val source: String,
    /** YYYY-MM-DD. */
    val date: String,
    val review: String? = null,
    val dueForReview: Boolean = false,
)

/** What an idea's feedback decided; [ruleId] is the rule it made (Undo deletes it), null for "Not now". */
data class ProactiveToast(val text: String, val ruleId: String?, val id: String = UUID.randomUUID().toString())

@Serializable private class FeedbackTarget(val kind: String, val id: String)
@Serializable private class ProactiveFeedbackBody(val target: FeedbackTarget, val action: String, val scope: String? = null)
@Serializable private class ProactiveFeedbackReply(val rule: ProactiveRule? = null)
@Serializable private class KeepBody(val keep: Boolean)

/**
 * POST /v1/proactive/feedback for an idea: the card leaves at once. "Not now" says it will not come back for two
 * weeks; "less" and "never" make a rule, shown with Undo (which deletes it).
 */
fun World.ideaFeedback(id: String, action: String, scope: String? = null) {
    update { s -> s.copy(ideas = s.ideas.filter { it.id != id }) }
    if (action == "not_now") showProactiveToast(ProactiveToast("Won't suggest this for two weeks", null))
    remote { api ->
        val raw = api.post("/v1/proactive/feedback", ProactiveFeedbackBody(FeedbackTarget("idea", id), action, scope))
        val rule = runCatching { JunoJson.decodeFromString<ProactiveFeedbackReply>(raw).rule }.getOrNull()
        if (action != "not_now" && rule != null) showProactiveToast(ProactiveToast(rule.text, rule.id))
    }
}

private fun World.showProactiveToast(toast: ProactiveToast) {
    update { it.copy(proactiveToast = toast) }
    scope.launch {
        delay(6_000)
        clearProactiveToast(toast.id)
    }
}

/** The snackbar went away (timeout or swipe): clear it if it is still this one. */
fun World.clearProactiveToast(id: String) = update { if (it.proactiveToast?.id == id) it.copy(proactiveToast = null) else it }

/** Undo on a toast: the rule it made is deleted. The idea stays gone. */
fun World.undoProactiveRule(toast: ProactiveToast) {
    clearProactiveToast(toast.id)
    val ruleId = toast.ruleId ?: return
    remote { it.delete("/v1/proactive/rules/$ruleId") }
}

/** GET /v1/proactive/rules; null when it cannot be read. */
suspend fun World.proactiveRules(): List<ProactiveRule>? = runCatching { api?.list<ProactiveRule>("/v1/proactive/rules") }.getOrNull()

fun World.removeProactiveRule(id: String) = remote { it.delete("/v1/proactive/rules/$id") }

/** "Keep" on a rule due for review: the server pushes the review date out 90 days. */
fun World.keepProactiveRule(id: String) = remote { it.patch("/v1/proactive/rules/$id", KeepBody(true)) }
