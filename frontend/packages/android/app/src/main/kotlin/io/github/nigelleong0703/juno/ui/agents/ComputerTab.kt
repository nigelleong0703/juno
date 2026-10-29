package io.github.nigelleong0703.juno.ui.agents

import androidx.compose.foundation.layout.Arrangement
import io.github.nigelleong0703.juno.ui.components.EmptyLine
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.agentsData
import io.github.nigelleong0703.juno.state.screenId
import io.github.nigelleong0703.juno.ui.agents.workspace.FullScreenComputer
import io.github.nigelleong0703.juno.ui.agents.workspace.ScreenFrame
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.ButtonSize
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/**
 * A preview of the agent's screen (spec 2.6). The "Open browser" take-over is not ported: the button here opens the
 * same picture full screen, view only.
 */
@Composable
fun ComputerTab(agentId: String) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val data by world.agentsData.collectAsState()
    val c = JunoTheme.colors
    var fullScreen by remember { mutableStateOf(false) }
    LaunchedEffect(agentId) { world.screenId(agentId) }
    val active = state.activeRunsOf(agentId)
    // Reads steps, which are null until loaded, so this can say 0 (spec 2.6 note).
    val browserTasks = state.runs.count { r -> r.agentId == agentId && r.steps.orEmpty().any { it.kind == "browser" } }
    // iOS shows the screen only when there is a picture or a display it knows of. With no computer at all (the list is
    // empty) a display id is not a screen, so the tasks line shows instead of the "No computer yet" panel.
    val hasPicture = data.screenshots[agentId] != null || (data.screenIds[agentId] != null && data.computers.isNotEmpty())

    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        when {
            hasPicture -> Box {
                ScreenFrame(agentId)
                JunoButton("Open full screen", { fullScreen = true }, Modifier.align(Alignment.BottomEnd).padding(12.dp), ButtonVariant.Secondary, size = ButtonSize.Regular)
            }
            browserTasks > 0 || active.isNotEmpty() -> {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("${maxOf(browserTasks, 1)} browser task${if (browserTasks > 1) "s" else ""}", style = junoText(TextSize.Lg, FontWeight.Medium), color = c.fg, modifier = Modifier.weight(1f))
                    Spinner()
                }
                Text(if (active.isEmpty()) "No screen yet" else "Starting browser…", style = junoText(TextSize.Md), color = c.fg)
            }
            else -> EmptyLine("No browser activity yet.")
        }
    }
    if (fullScreen) FullScreenComputer(agentId) { fullScreen = false }
}
