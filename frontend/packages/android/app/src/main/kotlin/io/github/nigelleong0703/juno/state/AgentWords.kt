package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.Agent
import io.github.nigelleong0703.juno.contract.Request
import io.github.nigelleong0703.juno.contract.Step
import io.github.nigelleong0703.juno.core.parseIso
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/** Formatting shared by the agents screens (iOS `Fmt`, App/Shared.swift:185-260). Pure: tested where it has logic. */
object Fmt {
    private val shortTime = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)
    private fun pattern(p: String) = DateTimeFormatter.ofPattern(p, Locale.getDefault())

    /** "5 min ago" / "in 2 hr" (iOS RelativeDateTimeFormatter, short). */
    fun ago(text: String?, now: Instant = Instant.now()): String {
        val at = parseIso(text) ?: return ""
        val seconds = Duration.between(at, now).seconds
        val n = kotlin.math.abs(seconds)
        val (value, unit) = when {
            n < 60 -> return if (seconds >= 0) "now" else "in a moment"
            n < 3600 -> n / 60 to "min"
            n < 86_400 -> n / 3600 to "hr"
            n < 86_400 * 30 -> n / 86_400 to "day"
            n < 86_400 * 365 -> n / (86_400 * 30) to "mo"
            else -> n / (86_400 * 365) to "yr"
        }
        val plural = if (unit == "day" && value != 1L) "days" else unit
        return if (seconds >= 0) "$value $plural ago" else "in $value $plural"
    }

    fun time(text: String?, zone: ZoneId = ZoneId.systemDefault()): String =
        parseIso(text)?.atZone(zone)?.format(shortTime).orEmpty()

    /** "Mon 21 Oct, 14:05". */
    fun dayTime(text: String?, zone: ZoneId = ZoneId.systemDefault()): String =
        parseIso(text)?.atZone(zone)?.format(pattern("EEE d MMM, HH:mm")).orEmpty()

    fun date(text: String?, zone: ZoneId = ZoneId.systemDefault()): String =
        parseIso(text)?.atZone(zone)?.format(pattern("d MMM yyyy")).orEmpty()

    fun duration(ms: Long?): String {
        ms ?: return ""
        val s = ms / 1000
        return when {
            s < 60 -> "${maxOf(s, 1)}s"
            s < 3600 -> "${s / 60}m"
            else -> "${s / 3600}h ${s % 3600 / 60}m"
        }
    }

    /** The one status vocabulary, shared by agents and runs. */
    fun status(s: String?): String = when (s) {
        "working" -> "Working"; "running" -> "Running"; "queued" -> "Queued"; "scheduled" -> "Scheduled"
        "needs_you" -> "Needs you"; "waiting_for_input" -> "Waiting for you"; "blocked" -> "Blocked"
        "completed" -> "Completed"; "failed" -> "Failed"; "stopped" -> "Stopped"; "sleeping" -> "Sleeping"; "error" -> "Error"
        null, "idle" -> "Idle"
        else -> s.replace('_', ' ').replaceFirstChar { it.uppercase() }
    }

    /** A run's error in words: model-service failures say what to do; anything else keeps its first line without the JSON body. */
    fun runError(raw: String): String {
        if ("(402)" in raw || raw.contains("insufficient", ignoreCase = true)) return "The model service is out of credit. Pick another model in Settings or top it up."
        if ("(401)" in raw || "(403)" in raw) return "The model service rejected the key. Check the model settings."
        if ("(429)" in raw) return "The model service is busy (rate limited). Try again in a moment."
        return raw.lineSequence().first().substringBefore('{').trim().trim(':').ifEmpty { raw }
    }

    fun requestTitle(kind: String?): String = when (kind) {
        "question" -> "Question"; "signin" -> "Sign-in needed"; "admin" -> "Access request"; "computer" -> "Take over"
        "secure_input" -> "Secure input"; "connect" -> "Connect an app"; else -> "Approval needed"
    }

    fun capitalized(s: String?): String = s.orEmpty().replaceFirstChar { it.uppercase() }
}

/** Colour reserved for state (iOS `StatusTone`). */
enum class StatusTone {
    Success, Warning, Danger, Neutral;
    companion object {
        fun of(status: String?) = when (status) {
            "working", "running", "completed" -> Success
            "needs_you", "waiting_for_input", "blocked", "waiting" -> Warning
            "error", "failed" -> Danger
            else -> Neutral
        }
    }
}

/** The request's one-line sentence: the brief's, else its summary or title. */
val Request.sentence: String get() = payload?.brief?.sentence?.takeIf { it.isNotEmpty() } ?: summary?.takeIf { it.isNotEmpty() } ?: title.orEmpty()

/** A task's progress line. The server writes the newest step as "<verb> <target>" ("Executed browser.click"); say it in words, never the raw tool name. */
fun progressText(progress: String): String {
    val parts = progress.trim().split(" ", limit = 2)
    if (parts.size != 2 || parts[0] != "Executed" || " " in parts[1]) return progress
    return when {
        parts[1].startsWith("browser") -> "Using the browser"
        parts[1].startsWith("shell") -> "Running a command"
        parts[1].startsWith("computer") -> "Using the computer"
        else -> "Working…"
    }
}

/** What the step row says: its title, else "verb target"; null for a step with nothing to say. */
fun stepLine(step: Step): String? =
    (step.title?.takeIf { it.isNotEmpty() } ?: listOfNotNull(step.verb, step.target).joinToString(" ").trim()).takeIf { it.isNotEmpty() }

/** The steps worth a row: one that reads the same as the one before shows once. */
fun visibleSteps(steps: List<Step>): List<Step> {
    var last: String? = null
    return steps.filter { step ->
        val line = stepLine(step)
        (line != null && line != last).also { if (line != null) last = line }
    }
}

/** A running line never starts with the room mention that triggered it ("@all introduce yourselves"). */
fun withoutLeadingMentions(text: String): String = text.replace(Regex("^(\\s*@\\S+)+\\s*"), "")

/**
 * The server's own notes to the agent (a wake-up after the user's tap on a card, "[system note, from the user's tap on a
 * card] ...") become a run's title when a run starts from them. They are internal text, never a line about the agent.
 */
fun isInternalNote(text: String): Boolean = text.trimStart().startsWith("[system note")

const val NOT_WORKING = "Not working on anything right now"

/** iOS `World.doingLine`: the running task's progress, "Waiting on you", or the latest short title. */
fun WorldState.doingLine(agent: Agent): String {
    taskList(agent.id).firstOrNull { it.status == "running" }?.progress?.takeIf { it.isNotEmpty() }?.let { return progressText(it) }
    if (((agent.needsYou ?: 0) > 0 || needsYouOf(agent.id).isNotEmpty()) && doing[agent.id] == null) return "Waiting on you"
    val latest = runs.filter { it.agentId == agent.id && it.parentRunId == null }.maxByOrNull { it.startedAt.orEmpty() }
    return listOf(doing[agent.id], activeRunsOf(agent.id).firstOrNull()?.title, latest?.title, agent.lastActivity)
        .mapNotNull { it?.let(::withoutLeadingMentions) }.filterNot(::isInternalNote).firstOrNull { it.isNotEmpty() } ?: NOT_WORKING
}

/** The plain status under the name on the profile header. */
fun statusLabel(status: String?) = when (status) { "sleeping" -> "Sleeping"; "error" -> "Error"; "needs_you" -> "Needs you"; else -> "Connected" }

/** The profile header line (spec 2.1): the doing line only while working or needing you. */
fun WorldState.profileLine(agent: Agent): String {
    val working = activeRunsOf(agent.id).isNotEmpty() || taskList(agent.id).any { it.status == "running" }
    if (working || (agent.needsYou ?: 0) > 0 || needsYouOf(agent.id).isNotEmpty()) {
        val line = doingLine(agent)
        return if (line == NOT_WORKING) statusLabel(agent.status) else line
    }
    return statusLabel(agent.status)
}

/**
 * ALIGNMENT_SYNTHESIS.md keeps the shared body plus only this agent's section: sections start with
 * `## <name>（<agentId>）` (full-width parentheses). Other agents' sections are dropped.
 */
fun replyStyle(content: String, agentId: String): String {
    var keep = true
    return content.split("\n").filter { line ->
        if (line.startsWith("## ")) {
            val open = line.lastIndexOf('（')
            keep = if (open >= 0 && line.endsWith("）")) line.substring(open + 1, line.length - 1) == agentId else true
        }
        keep
    }.joinToString("\n").trim()
}
