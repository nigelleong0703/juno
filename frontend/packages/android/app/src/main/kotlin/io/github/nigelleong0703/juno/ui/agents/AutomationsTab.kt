package io.github.nigelleong0703.juno.ui.agents

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.ExperimentalFoundationApi
import io.github.nigelleong0703.juno.ui.components.ShowMore
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Routine
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.agentsData
import io.github.nigelleong0703.juno.state.loadRoutines
import io.github.nigelleong0703.juno.state.openChat
import io.github.nigelleong0703.juno.ui.components.ButtonSize
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.routines.DeleteRoutineDialog
import io.github.nigelleong0703.juno.ui.routines.RoutineSetupNote
import io.github.nigelleong0703.juno.ui.routines.RoutineSwitch
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** This agent's routines by name, 12 at a time, with the on/off switch, a Delete menu and "New automation" (spec 2.17). */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun AutomationsTab(agentId: String) {
    val world = LocalWorld.current
    val data by world.agentsData.collectAsState()
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    var limit by remember { mutableIntStateOf(12) }
    var deleting by remember { mutableStateOf<Routine?>(null) }
    LaunchedEffect(Unit) { world.loadRoutines() }
    val all = data.routines.filter { it.agentId == agentId }.sortedBy { it.name.orEmpty().lowercase() }

    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        all.take(limit).forEach { routine ->
            Column(Modifier.combinedClickable(onClick = {}, onLongClick = { deleting = routine }), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    IconTile(JunoIcons.CalendarClock, size = 36.dp, radius = 9.dp)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(routine.name.orEmpty(), style = junoText(TextSize.Lg, FontWeight.SemiBold), color = c.fg, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        routine.trigger?.human?.takeIf { it.isNotEmpty() }?.let { Text(it, style = junoText(TextSize.Md), color = c.fgMuted, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    }
                    RoutineSwitch(routine)
                    RoutineMenu { deleting = routine }
                }
                Box(Modifier.padding(start = 48.dp)) { RoutineSetupNote(routine) }
            }
        }
        ShowMore(minOf(limit, all.size), all.size, { limit += 12 })
        // iOS: a large glass button with a plus; the flat stand-in is a bordered pill (JunoButton, bordered).
        JunoButton(
            "New automation", { world.openChat(state.directConversation(agentId)?.id, draft = "") }, Modifier.fillMaxWidth(),
            ButtonVariant.Secondary, size = ButtonSize.Hero, leadingIcon = JunoIcons.Plus, bordered = true,
        )
    }
    DeleteRoutineDialog(deleting) { deleting = null }
}

@Composable
private fun RoutineMenu(onDelete: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton({ open = true }) { Icon(JunoIcons.Ellipsis, "More", tint = JunoTheme.colors.fgMuted) }
        DropdownMenu(open, { open = false }, containerColor = JunoTheme.colors.card) {
            DropdownMenuItem(text = { Text("Delete", color = JunoStatus.danger) }, onClick = { open = false; onDelete() })
        }
    }
}
