package io.github.nigelleong0703.juno.ui.chat

import io.github.nigelleong0703.juno.contract.Agent
import io.github.nigelleong0703.juno.contract.Mention

/**
 * @mentions in a group chat's composer. A room wakes only the agents a message mentions, so the composer offers the
 * members after an "@" and the message carries them (web lib/mentions.ts, iOS `Mentions`).
 */
object Mentions {
    val aliases = listOf("all", "everyone")

    /** The "@query" being typed at the end of the text (start of text or after whitespace), or null. */
    fun activeQuery(text: String): String? {
        val at = text.lastIndexOf('@')
        if (at < 0) return null
        if (at > 0 && !text[at - 1].isWhitespace()) return null
        val query = text.substring(at + 1)
        return query.takeIf { q -> q.all { it.isLetterOrDigit() || it == '_' || it == '-' } }
    }

    /** The text with the "@query" at its end replaced by a finished "@handle ". */
    fun completing(text: String, handle: String): String {
        val at = text.lastIndexOf('@')
        return if (at < 0) text else text.substring(0, at) + "@" + handle + " "
    }

    fun handle(agent: Agent): String = (agent.handle ?: agent.name ?: agent.id).replace("@", "").filter { !it.isWhitespace() }

    private val token = Regex("(?<![A-Za-z0-9_.])@([A-Za-z0-9_.-]+)")

    private fun stripCode(text: String) = text.replace(Regex("```[\\s\\S]*?(```|$)"), " ").replace(Regex("`[^`\\n]*`?"), " ")

    /** Picker selections still present in the text, plus typed @all / @everyone; code spans never count. */
    fun build(text: String, picked: List<Mention>): List<Mention> {
        val seen = HashSet<String>()
        val out = ArrayList<Mention>()
        for (m in token.findAll(stripCode(text))) {
            val t = m.groupValues[1].trimEnd('.').lowercase().ifEmpty { continue }
            val mention = if (t in aliases) Mention(kind = "agent", id = t, label = "@$t") else picked.firstOrNull { it.label?.lowercase() == "@$t" }
            if (mention != null && seen.add(mention.id)) out += mention
        }
        return out
    }
}
