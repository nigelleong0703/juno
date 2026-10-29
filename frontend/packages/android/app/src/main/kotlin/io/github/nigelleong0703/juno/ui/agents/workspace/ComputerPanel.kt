package io.github.nigelleong0703.juno.ui.agents.workspace

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.background
import io.github.nigelleong0703.juno.ui.components.ShowMore
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.github.nigelleong0703.juno.contract.AgentTask
import io.github.nigelleong0703.juno.contract.Request
import io.github.nigelleong0703.juno.nav.Route
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.open
import io.github.nigelleong0703.juno.state.TaskGroups
import io.github.nigelleong0703.juno.state.agentsData
import io.github.nigelleong0703.juno.state.loadTasks
import io.github.nigelleong0703.juno.state.resolve
import io.github.nigelleong0703.juno.state.returnControl
import io.github.nigelleong0703.juno.state.stopTask
import io.github.nigelleong0703.juno.ui.agents.TaskEntryRows
import io.github.nigelleong0703.juno.ui.agents.TabHeader
import io.github.nigelleong0703.juno.ui.agents.TaskSheets
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.ButtonSize
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/**
 * The workspace Computer segment (spec 2.7): needs-you banner, the screen (tap for full screen), then Now and Today tasks,
 * and a bottom bar with who has control: Take over (opens the take-over screen) or Return to agent, and Full screen.
 */
@Composable
fun ComputerPanel(agentId: String) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val data by world.agentsData.collectAsState()
    val c = JunoTheme.colors
    val agent = state.agent(agentId)
    val waiting = state.pendingOf(agentId).firstOrNull { it.kind == "approval" || it.kind == "question" }
    val user = data.computer?.controller == "user"
    var fullScreen by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxSize()) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            waiting?.let { NeedsYouBanner(agent?.name.orEmpty(), it) }
            ScreenFrame(agentId, Modifier.clickable { fullScreen = true })
            WorkspaceTasks(agentId)
        }
        // Hidden when the account is live and has no computers (spec 2.7).
        if (!(data.computersLoaded && data.computers.isEmpty())) {
            Row(Modifier.fillMaxWidth().background(c.panel).padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(if (user) "You have control" else "${agent?.name.orEmpty()} has control", style = junoText(TextSize.Base), color = c.fg, modifier = Modifier.weight(1f))
                if (user) JunoButton("Return to agent", { world.returnControl(agentId) }, variant = ButtonVariant.Secondary, size = ButtonSize.Regular)
                else JunoButton("Take over", { world.open(Route.Takeover(agentId)) }, size = ButtonSize.Regular, enabled = data.screenIds[agentId] != null || data.screenshots[agentId] != null)
                IconButton({ fullScreen = true }) { Icon(JunoIcons.Maximize, "Full screen", tint = c.fg) }
            }
        }
    }
    if (fullScreen) FullScreenComputer(agentId) { fullScreen = false }
}

/** Muted card for the first pending approval or question: skip the step, or continue (spec 2.7). */
@Composable
private fun NeedsYouBanner(agentName: String, request: Request) {
    val world = LocalWorld.current
    val c = JunoTheme.colors
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.xl)).background(c.muted).padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.padding(top = 6.dp).size(6.dp).clip(CircleShape).background(JunoStatus.warning))
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("Needs you", style = junoText(TextSize.Sm, FontWeight.Medium), color = c.fg)
                Text("$agentName is waiting for you before it continues.", style = junoText(TextSize.Xs), color = c.fgMuted)
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.End)) {
            JunoButton("Skip this step", { world.resolve(request.id, "denied") }, variant = ButtonVariant.Ghost, size = ButtonSize.Regular)
            JunoButton("I'm done, continue", { world.resolve(request.id, "approved") }, size = ButtonSize.Regular)
        }
    }
}

/** Now (running and waiting, capped at 10) then Today (finished today, 5 at a time); nothing when both are empty (spec 2.7). */
@Composable
private fun WorkspaceTasks(agentId: String) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    var limit by remember { mutableIntStateOf(5) }
    val open = remember { mutableStateOf<AgentTask?>(null) }
    LaunchedEffect(agentId) { world.loadTasks(agentId) }
    val layout = TaskGroups.layout(state.taskList(agentId), Int.MAX_VALUE)
    val now = layout.active.take(10)
    val today = layout.days.firstOrNull { it.title == "Today" }?.entries.orEmpty()
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        if (now.isNotEmpty()) { TabHeader("Now"); now.forEach { TaskEntryRows(it, { t -> open.value = t }, { t -> world.stopTask(t) }) } }
        if (today.isNotEmpty()) {
            TabHeader("Today")
            today.take(limit).forEach { TaskEntryRows(it, { t -> open.value = t }, { t -> world.stopTask(t) }) }
            ShowMore(minOf(limit, today.size), today.size, { limit += 5 })
        }
    }
    TaskSheets(open)
}

/** Full-screen computer view: the same picture on black with a close button. Landscape follows the device. */
@Composable
fun FullScreenComputer(agentId: String, onClose: () -> Unit) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    Dialog(onClose, DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            Box(Modifier.align(Alignment.Center).padding(16.dp)) { ScreenFrame(agentId) }
            Row(Modifier.align(Alignment.TopCenter).fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(state.agent(agentId)?.name ?: "Computer", style = junoText(TextSize.Md, FontWeight.SemiBold), color = Color.White, modifier = Modifier.weight(1f).padding(start = 8.dp))
                IconButton(onClose) { Icon(JunoIcons.Close, "Close", tint = Color.White) }
            }
        }
    }
}
