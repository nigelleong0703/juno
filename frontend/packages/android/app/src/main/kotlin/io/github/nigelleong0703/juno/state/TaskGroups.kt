package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.AgentTask
import io.github.nigelleong0703.juno.core.parseIso
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * How a task reads (iOS `TaskWords`, web `taskView.ts`; same words): one label per `status` + `waitingFor` + `outcome`, a line
 * for `outcomeDetail`, and where a tap goes. The server decides the state; nothing here infers it from text.
 */
object TaskWords {
    /** The status pill: words and tone. */
    fun phase(task: AgentTask): Pair<String, StatusTone> = when (task.status) {
        "queued" -> "Queued" to StatusTone.Neutral
        "running" -> "Running" to StatusTone.Success
        "waiting" -> when (task.waitingFor) {
            "approval" -> "Waiting for approval"
            "event" -> "Waiting for an event"
            "effect_review" -> "Needs your review"
            else -> "Waiting for you"
        } to StatusTone.Warning
        else -> when (task.outcome) {
            "failed" -> "Didn't finish" to StatusTone.Danger
            "cancelled" -> "Stopped" to StatusTone.Neutral
            "needs_input" -> "Needs your input" to StatusTone.Warning
            "unknown_effect" -> "Outcome unknown, check before retrying" to StatusTone.Warning
            else -> "Done" to StatusTone.Success
        }
    }

    /** The specific reason behind an outcome, in words. */
    fun detail(task: AgentTask): String? = when (task.outcomeDetail) {
        "timed_out" -> "Timed out"
        "step_limit" -> "Reached its step limit"
        "no_progress" -> "Stopped making progress"
        "verification_failed" -> "Could not verify the result"
        "dispatch_failed" -> "Could not be started"
        "state_unreadable" -> "Could not read its state"
        "stopped_by_owner" -> "Stopped by you"
        "stop_unconfirmed" -> "The stop may not have reached it"
        "effect_review" -> "An outside action may have happened"
        else -> null
    }

    /** The second line of a row: what it is doing now, the question it waits on, or how it ended. */
    fun subtitle(task: AgentTask): String = when (task.status) {
        "queued" -> if (task.outcomeDetail == "dispatch_failed") "Could not be started, will retry" else "Queued"
        "running" -> task.progress?.let(::progressText) ?: "Working…"
        "waiting" -> task.progress?.let { "${phase(task).first} · ${progressText(it)}" } ?: phase(task).first
        else -> listOfNotNull(detail(task), task.resultLine).filter { it.isNotEmpty() }.distinct().joinToString(" · ").ifEmpty { phase(task).first }
    }

    /** How urgent a task's need for the person is: approval 4, a question 3, a review or unknown outcome 2, ended needing input 1, else 0. */
    fun needsYouRank(task: AgentTask): Int = when {
        task.status == "waiting" -> when (task.waitingFor) { "approval" -> 4; "effect_review" -> 2; "event" -> 0; else -> 3 }
        task.outcome == "unknown_effect" -> 2
        task.outcome == "needs_input" -> 1
        else -> 0
    }

    /**
     * The conversation to open when a task needs the person: a question or approval it waits on, a recovery review of an action
     * that may have happened, or an ended `needs_input`. That conversation holds the request card.
     */
    fun needsYou(task: AgentTask): String? {
        val needs = (task.status == "waiting" && task.waitingFor != "event") || task.outcome == "needs_input" || task.outcome == "unknown_effect"
        return if (needs) task.conversationId else null
    }
}

/** A task with the tasks that hang under it. */
data class TaskNode(val task: AgentTask, val children: List<TaskNode>) {
    val tasks: List<AgentTask> get() = listOf(task) + children.flatMap { it.tasks }

    /** True when the task or anything under it needs the person (such children list first, so a cap never hides them). */
    val subtreeNeedsYou: Boolean get() = tasks.any { TaskWords.needsYouRank(it) > 0 }

    /** A group with a descendant that needs the person starts open. */
    val startsExpanded: Boolean get() = descendantsNeedingYou != null

    /**
     * What a folded parent must not hide: the pill of the most urgent descendant that needs the person (approval, then a question,
     * then a review or unknown outcome, then ended needing input) and the "N need you" line. Null when none does.
     */
    val descendantsNeedingYou: NeedsYouBelow? get() {
        val below = children.flatMap { it.tasks }.filter { TaskWords.needsYouRank(it) > 0 }
        val top = below.maxByOrNull { TaskWords.needsYouRank(it) } ?: return null
        val (label, tone) = TaskWords.phase(top)
        return NeedsYouBelow(label, tone, if (below.size == 1) "1 needs you" else "${below.size} need you")
    }
}

/** The pill and the line a parent row shows for a descendant that needs the person. */
data class NeedsYouBelow(val label: String, val tone: StatusTone, val line: String)

/** A top-level row of the list: a task with its subtree, or a routine with its runs. */
sealed interface TaskEntry {
    val id: String
    val tasks: List<AgentTask>
    /** Live while anything inside it is. */
    val isLive: Boolean get() = tasks.any(TaskGroups::isActive)

    data class Single(val node: TaskNode) : TaskEntry {
        override val id get() = node.task.id
        override val tasks get() = node.tasks
    }

    data class Routine(val routineId: String, val runs: List<TaskNode>) : TaskEntry {
        override val id get() = "routine-$routineId"
        override val tasks get() = runs.flatMap { it.tasks }
    }
}

/**
 * How the agent profile's Activity tab lays out tasks (iOS `TaskGroups`): live ones first, then the finished ones grouped by
 * day (Today, Yesterday, then the date), newest first, capped. Tasks group by `parentId`; routine runs gather under their routine.
 */
object TaskGroups {
    data class Day(val title: String, val entries: List<TaskEntry>)
    /** [finishedTotal] counts all finished entries, for "Show more". */
    data class Layout(val active: List<TaskEntry>, val days: List<Day>, val finishedTotal: Int)

    fun isActive(task: AgentTask) = task.status != "ended"

    private fun time(text: String?): Instant = parseIso(text) ?: Instant.MIN
    private fun startedAt(e: TaskEntry) = e.tasks.maxOfOrNull { time(it.startedAt) } ?: Instant.MIN
    private fun updatedAt(e: TaskEntry) = e.tasks.maxOfOrNull { time(it.finishedAt ?: it.updatedAt ?: it.startedAt) } ?: Instant.MIN

    /**
     * Group by `parentId`: a task whose parent is not in the list is top-level. A parent is found by task id, by the run a
     * subagent is (`childRunId`) or by the run a routine task is (`runId`). Children are oldest first.
     */
    fun tree(tasks: List<AgentTask>): List<TaskNode> {
        val byKey = HashMap<String, Int>()
        tasks.forEachIndexed { i, t -> listOfNotNull(t.id, t.childRunId, t.runId.takeIf { t.kind == "routine" }).forEach { byKey[it] = i } }
        val children = HashMap<Int, MutableList<Int>>()
        val top = mutableListOf<Int>()
        tasks.forEachIndexed { i, t ->
            val parent = t.parentId?.let { byKey[it] }
            if (parent != null && parent != i) children.getOrPut(parent) { mutableListOf() } += i else top += i
        }
        val seen = HashSet<Int>()
        fun node(i: Int): TaskNode {
            seen += i
            val kids = children[i].orEmpty().filter { it !in seen }.sortedBy { time(tasks[it].startedAt) }
            return TaskNode(tasks[i], kids.map { node(it) })
        }
        val nodes = top.map { node(it) }.toMutableList()
        // Tasks that point at each other in a loop never reach the top; show them there rather than lose them.
        tasks.indices.filter { it !in seen }.forEach { nodes += node(it) }
        return nodes
    }

    /** Routine runs gather under their routine (at the first run's position); everything else stays a single entry. */
    fun entries(tasks: List<AgentTask>): List<TaskEntry> {
        val entries = mutableListOf<TaskEntry>()
        val routineAt = HashMap<String, Int>()
        for (node in tree(tasks)) {
            val routineId = node.task.routineId.takeIf { node.task.kind == "routine" }
            if (routineId == null) { entries += TaskEntry.Single(node); continue }
            val at = routineAt[routineId]
            if (at == null) { routineAt[routineId] = entries.size; entries += TaskEntry.Routine(routineId, listOf(node)) }
            else entries[at] = (entries[at] as TaskEntry.Routine).let { it.copy(runs = it.runs + node) }
        }
        return entries
    }

    fun layout(tasks: List<AgentTask>, limit: Int, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): Layout {
        val all = entries(tasks)
        val active = all.filter { it.isLive }.sortedByDescending(::startedAt)
        val finished = all.filter { !it.isLive }.sortedByDescending(::updatedAt)
        val today = now.atZone(zone).toLocalDate()
        val days = mutableListOf<Day>()
        for (entry in finished.take(limit)) {
            val date: LocalDate = updatedAt(entry).atZone(zone).toLocalDate()
            val title = when (date) {
                today -> "Today"
                today.minusDays(1) -> "Yesterday"
                else -> date.format(DateTimeFormatter.ofPattern("d MMM", Locale.getDefault()))
            }
            val last = days.lastOrNull()
            if (last?.title == title) days[days.size - 1] = last.copy(entries = last.entries + entry) else days += Day(title, listOf(entry))
        }
        return Layout(active, days, finished.size)
    }
}
