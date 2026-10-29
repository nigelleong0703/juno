package io.github.nigelleong0703.juno.ui.routines

import androidx.compose.foundation.layout.Arrangement
import io.github.nigelleong0703.juno.ui.components.JunoSheet
import io.github.nigelleong0703.juno.ui.components.AgentAvatar
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Agent
import io.github.nigelleong0703.juno.contract.AgentCalendarItem
import io.github.nigelleong0703.juno.state.Fmt
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.agentsData
import io.github.nigelleong0703.juno.state.cancelCalendarItem
import io.github.nigelleong0703.juno.state.needsSetup
import io.github.nigelleong0703.juno.ui.theme.AvatarSize
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** Avatar + title + secondary line + trailing word (iOS `AgentRow`). */
@Composable
fun AgentRow(agent: Agent?, title: String, subtitle: String?, trailing: String? = null, modifier: Modifier = Modifier) {
    val c = JunoTheme.colors
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        AgentAvatar(agent, AvatarSize.lg)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row {
                Text(title, style = junoText(TextSize.Md, FontWeight.SemiBold), color = c.fg, maxLines = 1, modifier = Modifier.weight(1f))
                trailing?.let { Text(it, style = junoText(TextSize.Xs), color = c.fgMuted, modifier = Modifier.padding(start = 4.dp)) }
            }
            subtitle?.takeIf { it.isNotEmpty() }?.let { Text(it, style = junoText(TextSize.Base), color = c.fgMuted, maxLines = 2) }
        }
    }
}

/** A routine opened from the calendar: who runs it, when next and last, its state and the switch (spec 2.24). Reads the live routine. */
@Composable
fun RoutineSheet(routineId: String, onDismiss: () -> Unit) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val data by world.agentsData.collectAsState()
    val c = JunoTheme.colors
    val r = data.routine(routineId) ?: return
    JunoSheet(r.name.orEmpty(), onDismiss) {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            AgentRow(state.agent(r.agentId), r.name.orEmpty(), r.trigger?.human, routineStateWord(r))
            r.nextRunAt?.let { Text("Next run ${Fmt.dayTime(it)}", style = junoText(TextSize.Base), color = c.fgMuted) }
            r.lastRunAt?.let { Text("Last run ${Fmt.dayTime(it)}${if (r.lastRunStatus == "failed") " · failed" else ""}", style = junoText(TextSize.Base), color = c.fgMuted) }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Enabled", style = junoText(TextSize.Lg), color = c.fg, modifier = Modifier.weight(1f))
                RoutineSwitch(r)
            }
            RoutineSetupNote(r)
        }
    }
}

private fun kindLabel(kind: String?) = when (kind) { "meeting" -> "Meeting"; "task" -> "Task"; else -> "Follow-up" }
private fun statusLabel(status: String?) = when (status) { "done" -> "Done"; "missed" -> "Missed"; "cancelled" -> "Cancelled"; else -> "Scheduled" }

/** One item from an agent's own calendar: what, when, with whom, how it went; Cancel only while scheduled (spec 2.25). */
@Composable
fun CalendarItemSheet(itemId: String, fallback: AgentCalendarItem, onDismiss: () -> Unit) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val data by world.agentsData.collectAsState()
    val c = JunoTheme.colors
    var confirming by remember { mutableStateOf(false) }
    val item = data.calendar.firstOrNull { it.id == itemId } ?: fallback
    JunoSheet(item.title.orEmpty(), onDismiss) {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            AgentRow(state.agent(item.agentId), item.title.orEmpty(), kindLabel(item.kind), statusLabel(item.status))
            item.at?.let { Text(Fmt.dayTime(it), style = junoText(TextSize.Base), color = c.fgMuted) }
            item.withWhom?.name?.let { Text("With $it", style = junoText(TextSize.Base), color = c.fgMuted) }
            item.instructions?.takeIf { it.isNotEmpty() }?.let { Text(it, style = junoText(TextSize.Base), color = c.fg) }
            item.result?.takeIf { it.isNotEmpty() }?.let { Text(it, style = junoText(TextSize.Base), color = c.fgMuted) }
            if (item.status == "scheduled") TextButton({ confirming = true }, Modifier.fillMaxWidth()) { Text("Cancel item", color = JunoStatus.danger) }
        }
    }
    if (confirming) AlertDialog(
        onDismissRequest = { confirming = false }, title = { Text("Cancel this item?") }, text = { Text("The agent will not do it.") },
        confirmButton = { TextButton({ world.cancelCalendarItem(itemId); confirming = false; onDismiss() }) { Text("Cancel item", color = JunoStatus.danger) } },
        dismissButton = { TextButton({ confirming = false }) { Text("Keep") } },
    )
}
