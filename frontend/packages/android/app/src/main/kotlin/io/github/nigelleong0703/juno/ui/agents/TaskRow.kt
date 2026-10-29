package io.github.nigelleong0703.juno.ui.agents

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.AgentTask
import io.github.nigelleong0703.juno.state.Fmt
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.NeedsYouBelow
import io.github.nigelleong0703.juno.state.TaskEntry
import io.github.nigelleong0703.juno.state.TaskGroups
import io.github.nigelleong0703.juno.state.TaskNode
import io.github.nigelleong0703.juno.state.TaskWords
import io.github.nigelleong0703.juno.state.agentsData
import io.github.nigelleong0703.juno.state.openChat
import io.github.nigelleong0703.juno.state.startedByLine
import io.github.nigelleong0703.juno.ui.components.ShowMore
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

fun taskIcon(kind: String?): ImageVector = when (kind) {
    "subagent" -> JunoIcons.Users
    "routine" -> JunoIcons.CalendarClock
    "command" -> JunoIcons.Terminal
    "connector" -> JunoIcons.Plugins
    "wait" -> JunoIcons.Hourglass
    else -> JunoIcons.Grid
}

private fun needsYou(task: AgentTask) = task.status == "waiting" || task.outcome == "needs_input" || task.outcome == "unknown_effect"

/** The "Tasks (n)" / "Runs (n)" toggle at the end of a row that has more underneath. */
@Composable
private fun CountToggle(label: String, expanded: Boolean, onToggle: () -> Unit) {
    val c = JunoTheme.colors
    Row(Modifier.clip(RoundedCornerShape(Radius.lg)).clickable(onClick = onToggle).padding(4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = junoText(TextSize.Sm, FontWeight.Medium), color = c.fgMuted)
        Icon(if (expanded) JunoIcons.ChevronDown else JunoIcons.ChevronRight, null, tint = c.fgMuted, modifier = Modifier.size(12.dp))
    }
}

/**
 * An icon tile by kind, bold title, grey progress or outcome, time and who started it; a running task is highlighted with a
 * round Stop (spec 2.3). [count] > 0 adds the toggle that folds the children.
 */
@Composable
fun TaskRow(
    task: AgentTask, onStop: () -> Unit, modifier: Modifier = Modifier,
    nested: Boolean = false, count: Int = 0, expanded: Boolean = false, onToggle: () -> Unit = {}, below: NeedsYouBelow? = null,
) {
    val c = JunoTheme.colors
    val routines by LocalWorld.current.agentsData.collectAsState()
    val active = TaskGroups.isActive(task)
    val origin = task.origin
    val routineName = origin?.takeIf { it.type == io.github.nigelleong0703.juno.contract.RunOrigin.TypeValue.routine }?.let { o -> routines.routines.firstOrNull { it.id == o.routineId }?.name }
    Row(
        modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.xl)).background(if (active) c.muted else c.canvas).padding(if (active) 10.dp else 0.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        IconTile(taskIcon(task.kind), background = if (active) c.requestCard else c.muted)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(task.title ?: "Task", style = junoText(TextSize.Md, FontWeight.SemiBold), color = c.fg, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (below != null) {
                StatusPill(below.label, below.tone)
                Text(below.line, style = junoText(TextSize.Base), color = JunoStatus.warning)
            }
            Text(TaskWords.subtitle(task), style = junoText(TextSize.Base), color = if (needsYou(task)) JunoStatus.warning else c.fgMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(
                if (nested || origin == null) Fmt.time(task.startedAt) else "${Fmt.time(task.startedAt)} · ${startedByLine(origin, routineName)}",
                style = junoText(TextSize.Sm), color = c.fgSubtle,
            )
        }
        if (count > 0) CountToggle("Tasks ($count)", expanded, onToggle)
        if (task.status == "running") RoundStopButton(onStop)
    }
}

/**
 * A [TaskRow] that opens what a tap should: the conversation holding the request card when the task needs the person, else its
 * run's card, else the thread card (spec 5.5).
 */
@Composable
fun OpenableTaskRow(
    task: AgentTask, onOpen: (AgentTask) -> Unit, onStop: () -> Unit,
    nested: Boolean = false, count: Int = 0, expanded: Boolean = false, onToggle: () -> Unit = {}, below: NeedsYouBelow? = null,
) {
    val world = LocalWorld.current
    val needs = TaskWords.needsYou(task)
    val opens = needs != null || task.runId != null || task.childRunId != null || task.conversationId != null
    TaskRow(task, onStop, Modifier.then(if (opens) Modifier.clickable { if (needs != null) world.openChat(needs) else onOpen(task) } else Modifier), nested, count, expanded, onToggle, below)
}

/** Children shown under a parent before "Show more". */
private const val CHILDREN_PAGE = 5

/** A task with its children folded underneath: the count opens them, a few at a time. */
@Composable
fun TaskTreeRow(node: TaskNode, onOpen: (AgentTask) -> Unit, onStop: (AgentTask) -> Unit, nested: Boolean = false) {
    var expanded by remember { mutableStateOf(node.startsExpanded) }
    var shown by remember { mutableIntStateOf(CHILDREN_PAGE) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OpenableTaskRow(node.task, onOpen, { onStop(node.task) }, nested, node.children.size, expanded, { expanded = !expanded }, node.descendantsNeedingYou)
        if (expanded) Column(Modifier.padding(start = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            // Children that need the person (or hold one that does) list first, so the cap never hides them.
            node.children.sortedByDescending { it.subtreeNeedsYou }.take(shown).forEach { TaskTreeRow(it, onOpen, onStop, nested = true) }
            ShowMore(minOf(shown, node.children.size), node.children.size, { shown += CHILDREN_PAGE })
        }
    }
}

/** Routine runs under their routine: its name, the newest run's state and a "Runs (n)" count; the runs open underneath. */
@Composable
private fun RoutineRunsRow(entry: TaskEntry.Routine, onOpen: (AgentTask) -> Unit, onStop: (AgentTask) -> Unit) {
    val c = JunoTheme.colors
    val routines by LocalWorld.current.agentsData.collectAsState()
    var expanded by remember { mutableStateOf(false) }
    var shown by remember { mutableIntStateOf(CHILDREN_PAGE) }
    val live = entry.runs.any { TaskGroups.isActive(it.task) }
    val title = routines.routines.firstOrNull { it.id == entry.routineId }?.name ?: "Routine"
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.xl)).background(if (live) c.muted else c.canvas).clickable { expanded = !expanded }.padding(if (live) 10.dp else 0.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            IconTile(taskIcon("routine"), background = if (live) c.requestCard else c.muted)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title, style = junoText(TextSize.Md, FontWeight.SemiBold), color = c.fg, maxLines = 2, overflow = TextOverflow.Ellipsis)
                entry.runs.firstOrNull()?.let { Text(TaskWords.subtitle(it.task), style = junoText(TextSize.Base), color = c.fgMuted, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            }
            CountToggle("Runs (${entry.runs.size})", expanded) { expanded = !expanded }
        }
        if (expanded) Column(Modifier.padding(start = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            entry.runs.take(shown).forEach { TaskTreeRow(it, onOpen, onStop, nested = true) }
            ShowMore(minOf(shown, entry.runs.size), entry.runs.size, { shown += CHILDREN_PAGE })
        }
    }
}

/** The rows of one list entry: a task with its subtree, or a routine with its runs. */
@Composable
fun TaskEntryRows(entry: TaskEntry, onOpen: (AgentTask) -> Unit, onStop: (AgentTask) -> Unit) {
    when (entry) {
        is TaskEntry.Single -> TaskTreeRow(entry.node, onOpen, onStop)
        is TaskEntry.Routine -> RoutineRunsRow(entry, onOpen, onStop)
    }
}
