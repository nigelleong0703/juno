package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.Rule
import io.github.nigelleong0703.juno.core.parseIso
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** A request's decision brief in words: categories, outcomes and a delegation's limits (iOS Chat/DecisionBrief.swift). */
object DecisionWords {
    fun badge(category: String?) = when (category) {
        "spending" -> "Spending"; "speaking" -> "Speaking"; "public" -> "Public"; "committing" -> "Commits you"
        "irreversible" -> "Can't be undone"; "sensitive" -> "Sensitive"; "sharing" -> "Share between chats"
        "setup" -> "Setup"; "choice" -> "Your choice"; else -> "Decision"
    }

    /** The row name in the authority table. */
    fun name(category: String?) = if (category == "committing") "Committing" else badge(category)

    /** Categories an agent can be given authority over; the rest always ask. */
    val delegable = listOf("spending", "speaking", "committing", "public", "sharing")
    val alwaysAsk = listOf("irreversible", "sensitive", "setup", "choice")
    val outcomes = listOf("allowed_once", "allowed_rule", "denied", "revised", "timed_out", "cancelled", "handed_back")

    fun alwaysAsksNote(category: String) = if (category == "choice") "Your decision" else "Always asks"

    fun outcome(outcome: String?): String? = when (outcome) {
        "allowed_once" -> "Allowed once"; "allowed_rule" -> "Allowed by your rule"; "denied" -> "Denied"
        "revised" -> "Sent back to change"; "timed_out" -> "Timed out"; "cancelled" -> "Cancelled"; "handed_back" -> "Handed back"
        else -> null
    }

    private val days = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

    /** "Mon-Fri 9-17". */
    private fun windowText(w: io.github.nigelleong0703.juno.contract.DelegationLimits.Window): String {
        val d = w.days.orEmpty().filter { it in 0..7 }.sorted()
        val consecutive = d.size >= 3 && d.zipWithNext().all { (a, b) -> b == a + 1 }
        val dayText = if (consecutive) "${days[d.first().toInt()]}-${days[d.last().toInt()]}" else d.joinToString(", ") { days[it.toInt()] }
        fun hour(s: String?) = s?.takeIf { it.isNotEmpty() }?.let { h -> h.removeSuffix(":00").let { if (it.startsWith("0") && it.length > 1) it.drop(1) else it } }
        val hours = listOfNotNull(hour(w.start), hour(w.end)).joinToString("-")
        return listOf(dayText, hours).filter { it.isNotEmpty() }.joinToString(" ")
    }

    private fun money(amount: String?, currency: String?): String? {
        val n = amount?.toDoubleOrNull() ?: return null
        val symbol = when (currency) { null, "USD" -> "$"; "EUR" -> "€"; "GBP" -> "£"; "CNY" -> "¥"; else -> "$currency " }
        return symbol + (if (n % 1.0 == 0.0) n.toLong().toString() else "%.2f".format(n))
    }

    /** "Up to $50 each, $200/month on Stripe": the limits of a delegation. For sharing, [platform] is the source chat's name. */
    fun limitsSummary(rule: Rule, platform: String, chatName: (String) -> String = { it }): String {
        val l = rule.delegation?.limits
        val parts = mutableListOf<String>()
        when (rule.delegation?.category) {
            "sharing" -> {
                val targets = l?.recipients.orEmpty().map(chatName)
                return if (targets.isEmpty()) "Files from $platform" else "Files from $platform → ${targets.joinToString(", ")}"
            }
            "spending" -> {
                money(l?.perPurchase?.amount, l?.perPurchase?.currency)?.let { parts += "Up to $it each" }
                money(l?.perMonth?.amount, l?.perMonth?.currency)?.let { parts += "$it/month" }
                if (l?.allowRecurring == true) parts += "subscriptions OK"
            }
            "speaking" -> { parts += if (l?.replyOnly == true) "Replies only" else "Messages"; l?.maxPerDay?.let { parts += "up to $it/day" } }
            "committing" -> { parts += if (l?.acceptOnly == true) "Accepts only" else "Accepts and sends invites"; l?.window?.let { parts += windowText(it) } }
            "public" -> { parts += "Posts"; l?.maxPerDay?.let { parts += "up to $it/day" } }
        }
        val text = parts.joinToString(", ")
        return if (platform.isEmpty()) text else "$text on $platform"
    }

    /** "expires Jan 20" (with the year when it is not this one); null when the rule has no end or has already ended. */
    fun expiresText(rule: Rule, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String? {
        val end = parseIso(rule.expiresAt)?.takeIf { it > now } ?: return null
        val sameYear = end.atZone(zone).year == now.atZone(zone).year
        return "expires " + end.atZone(zone).format(DateTimeFormatter.ofPattern(if (sameYear) "d MMM" else "d MMM yyyy", Locale.getDefault()))
    }

    /** The platform a delegation covers, from its key ("app:gmail", "site:instagram.com", "chat:<id>", "juno"). */
    fun platformName(key: String?, chatName: (String?) -> String): String {
        val parts = key.orEmpty().split(":", limit = 2)
        return when (parts[0]) {
            "app" -> parts.getOrElse(1) { "" }.replace('-', ' ').replaceFirstChar { it.uppercase() }
            "site" -> parts.getOrElse(1) { "" }
            "chat" -> chatName(parts.getOrNull(1))
            "juno" -> "Juno"
            else -> ""
        }
    }
}
