package io.github.nigelleong0703.juno.state

/**
 * A people page (`people/<x>.md`): the shared body the user may edit, then read-only `## Name（agentId）` sections
 * written by each agent. The separator is the FULL-WIDTH parenthesis; ASCII parentheses are ordinary text.
 */
object PersonPage {
    data class Section(val heading: String, val text: String)
    data class Split(val body: String, val sections: List<Section>)

    fun split(content: String): Split {
        val lines = content.split("\n")
        val starts = lines.indices.filter { i ->
            val line = lines[i]
            line.startsWith("## ") && line.trim().endsWith("）") && line.contains("（")
        }
        if (starts.isEmpty()) return Split(content, emptyList())
        val body = lines.subList(0, starts[0]).joinToString("\n").trim() + "\n"
        val sections = starts.mapIndexed { n, start ->
            val end = if (n + 1 < starts.size) starts[n + 1] else lines.size
            Section(
                heading = lines[start].drop(3).trim(),
                text = lines.subList(start + 1, end).joinToString("\n").trim(),
            )
        }
        return Split(body, sections)
    }

    /** The body (edited) with the sections (unchanged) joined back in the file's own shape. */
    fun join(body: String, sections: List<Section>): String {
        val head = body.trim() + "\n"
        if (sections.isEmpty()) return head
        return head + "\n" + sections.joinToString("\n\n") { "## ${it.heading}\n\n${it.text}" } + "\n"
    }

    /** The first `# ` heading, else the file name without its extension. */
    fun name(path: String, content: String): String {
        content.split("\n").firstOrNull { it.startsWith("# ") }?.let { return it.drop(2).trim() }
        return path.substringAfterLast('/').substringBeforeLast('.')
    }
}

/** `memory/<YYYY-MM-DD>/<agentId>.md`: the only daily-note shape the Memory page reads. */
data class DailyNotePath(val date: String, val agentId: String)

object DailyNotes {
    private val date = Regex("""\d{4}-\d{2}-\d{2}""")

    fun parse(path: String): DailyNotePath? {
        val parts = path.split("/")
        if (parts.size != 3 || parts[0] != "memory" || !parts[2].endsWith(".md")) return null
        if (!date.matches(parts[1])) return null
        return DailyNotePath(parts[1], parts[2].dropLast(3))
    }
}
