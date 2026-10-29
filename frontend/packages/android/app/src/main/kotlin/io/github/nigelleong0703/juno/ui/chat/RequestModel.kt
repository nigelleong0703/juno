package io.github.nigelleong0703.juno.ui.chat

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.ui.graphics.vector.ImageVector
import io.github.nigelleong0703.juno.contract.DecisionBrief
import io.github.nigelleong0703.juno.contract.Request
import java.text.NumberFormat
import java.util.Currency
import java.util.Locale

/** What a request looks like to the user, picked from its kind and payload (iOS `RequestFlavor`). */
enum class Flavor { Decision, Checkout, Send, Command, Generic, Question, Secure, Takeover, Signin, Connect }

fun Request.flavor(): Flavor {
    when (kind) {
        "question" -> return Flavor.Question
        "secure_input" -> return Flavor.Secure
        "computer" -> return Flavor.Takeover
        "signin" -> return Flavor.Signin
        "connect" -> return Flavor.Connect
    }
    val p = payload
    val action = (p?.action ?: "").lowercase()
    return when {
        p?.brief != null -> Flavor.Decision
        p?.purchase != null -> Flavor.Checkout
        p?.draft != null || listOf("send", "reply", "email", "mail", "message", "sms").any { it in action } -> Flavor.Send
        listOf("bash", "shell", "command", "exec", "terminal").any { it in action } -> Flavor.Command
        else -> Flavor.Generic
    }
}

/** "Ask the user for" in words: password / card details / code. */
fun Request.secretNoun(): String {
    val kinds = payload?.fields.orEmpty().mapNotNull { it.kind }.toSet()
    return when {
        kinds.any { it.startsWith("card") } -> "card details"
        kinds == setOf("password") -> "password"
        kinds == setOf("otp") -> "code"
        else -> "details"
    }
}

/** Tool names like "gmail_send_email" or "browser.click" as words. */
fun Request.actionWords(): String = (payload?.action ?: "use a tool").replace('_', ' ').replace('.', ' ').lowercase()

/** The server's words and symbols for a decision brief's categories (iOS `DecisionWords`). */
object DecisionWords {
    fun badge(category: String?): String = when (category) {
        "spending" -> "Spending"; "speaking" -> "Speaking"; "public" -> "Public"; "committing" -> "Commits you"
        "irreversible" -> "Can't be undone"; "sensitive" -> "Sensitive"; "sharing" -> "Share between chats"
        "setup" -> "Setup"; "choice" -> "Your choice"; else -> "Decision"
    }

    fun icon(category: String?): ImageVector = when (category) {
        "spending" -> JunoIcons.CreditCard; "speaking" -> JunoIcons.Chat; "public" -> JunoIcons.Megaphone
        "committing" -> JunoIcons.CalendarCheck; "irreversible" -> JunoIcons.Trash; "sensitive" -> JunoIcons.Lock
        "sharing" -> JunoIcons.Share; "setup" -> JunoIcons.Settings; "choice" -> JunoIcons.List
        else -> JunoIcons.Hand
    }

    /** The server's `Request.outcome` in words; null for a value this app does not know. */
    fun outcome(outcome: String?): String? = when (outcome) {
        "allowed_once" -> "Allowed once"; "allowed_rule" -> "Allowed by your rule"; "denied" -> "Denied"; "revised" -> "Sent back to change"
        "timed_out" -> "Timed out"; "cancelled" -> "Cancelled"; "handed_back" -> "Handed back"; else -> null
    }

    enum class Tone { Done, Refused, Neutral }

    fun tone(outcome: String?): Tone = when (outcome) {
        "allowed_once", "allowed_rule" -> Tone.Done; "denied", "revised" -> Tone.Refused; else -> Tone.Neutral
    }

    /** Primary first, then the others; at most two badges. */
    fun badges(brief: DecisionBrief?): List<String> {
        val all = ArrayList<String>()
        brief?.primary?.let { all += it }
        for (c in brief?.categories.orEmpty()) if (c !in all) all += c
        return all.take(2)
    }

    /** "$30.00"; null when the amount does not parse. */
    fun money(amount: String?, currency: String?): String? {
        val value = amount?.toBigDecimalOrNull() ?: return null
        val format = NumberFormat.getCurrencyInstance(Locale.getDefault())
        runCatching { format.currency = Currency.getInstance(currency ?: "USD") }
        return format.format(value)
    }
}

/** One line of what the decision costs or risks; a [declared] fact is only what the agent says. */
data class Consequence(val icon: ImageVector, val text: String, val declared: Boolean)

/** The heaviest facts of a brief, at most three (iOS `DecisionBrief.consequences`). */
fun DecisionBrief.consequences(): List<Consequence> {
    val f = facts ?: return emptyList()
    val out = ArrayList<Consequence>()
    fun declared(source: String?) = source == "declared"
    f.reversible?.takeIf { it.value == "no" || it.value == "hard" }?.let {
        out += Consequence(DecisionWords.icon("irreversible"), if (it.value == "no") "Can't be undone" else "Hard to undo", declared(it.source))
    }
    f.money?.let { m ->
        DecisionWords.money(m.amount, m.currency)?.let { amount ->
            val every = mapOf("weekly" to "week", "monthly" to "month", "yearly" to "year")[m.recurring]?.let { " / $it" }.orEmpty()
            out += Consequence(DecisionWords.icon("spending"), amount + every + (m.merchant?.let { " at $it" }.orEmpty()), declared(m.source))
        }
    }
    f.sensitive?.firstOrNull()?.let { out += Consequence(DecisionWords.icon("sensitive"), it.label ?: "Sensitive details", declared(it.source)) }
    f.commitments?.firstOrNull()?.takeIf { it.text != null }?.let { out += Consequence(DecisionWords.icon("committing"), "Commits: ${it.text}", declared(it.source)) }
    f.audience?.let { a -> audienceText(a)?.let { out += Consequence(DecisionWords.icon("speaking"), it, declared(a.source)) } }
    f.asAccount?.label?.let { out += Consequence(DecisionWords.icon("setup"), "As $it", declared(f.asAccount?.source)) }
    return out.take(3)
}

private fun audienceText(a: io.github.nigelleong0703.juno.contract.DecisionFacts.Audience): String? {
    if (a.kind == "public") return "Anyone can see it"
    val names = a.recipients.orEmpty().mapNotNull { it.name ?: it.address }
    if (names.isNotEmpty()) {
        val more = maxOf((a.count ?: names.size.toLong()) - 2, 0)
        return "To " + names.take(2).joinToString(", ") + if (more > 0) " +$more" else ""
    }
    if (a.kind == "room") return "To the room"
    return a.count?.let { "To $it ${if (it == 1L) "person" else "people"}" }
}
