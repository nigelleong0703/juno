package io.github.nigelleong0703.juno.ui.shell

import io.github.nigelleong0703.juno.ui.components.GroupedSection
import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Agent
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.doingLine
import io.github.nigelleong0703.juno.state.setScope
import io.github.nigelleong0703.juno.ui.components.AgentAvatar
import io.github.nigelleong0703.juno.ui.components.JunoSheet
import io.github.nigelleong0703.juno.ui.settings.SettingsEmpty
import io.github.nigelleong0703.juno.ui.theme.AvatarSize
import io.github.nigelleong0703.juno.ui.theme.JunoTheme

/**
 * The agent scope in the header of every top-level tab (iOS `AgentScopeButton`, compact): a pill with stacked figures for
 * "All", one figure when an agent is picked. Tapping it opens [AgentPickerSheet].
 */
@Composable
fun AgentScopeButton() {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    var choosing by remember { mutableStateOf(false) }
    val agent = state.agent(state.scope)
    val label = "Agent: ${agent?.name ?: "All agents"}"
    CircleButton(label, width = 64.dp, shape = RoundedCornerShape(percent = 50), onClick = { choosing = true }) {
        if (agent != null) AgentAvatar(agent, AvatarSize.md)
        else StackedFigures(state.agents.take(3), AvatarSize.md)
    }
    if (choosing) AgentPickerSheet { choosing = false }
}

/** Overlapping figures, the web's avatar group (iOS `StackedFigures`): each 0.8 of [size], overlapping by 0.35 of it. */
@Composable
fun StackedFigures(agents: List<Agent>, size: Dp, modifier: Modifier = Modifier) {
    Row(modifier.height(size), horizontalArrangement = Arrangement.spacedBy(-size * 0.35f), verticalAlignment = Alignment.CenterVertically) {
        agents.forEach { AgentAvatar(it, size * 0.8f) }
    }
}

/**
 * Every agent, plus "All agents" (iOS `AgentPickerSheet`). Picking one sets the world scope for every top-level tab at
 * once; the checkmark marks the current scope.
 */
@Composable
fun AgentPickerSheet(onDismiss: () -> Unit) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val check: @Composable () -> Unit = { Icon(JunoIcons.Check, "Selected", tint = JunoTheme.colors.fg) }
    JunoSheet(title = "Agents", onDismiss = onDismiss, long = true) {
        GroupedSection {
            AgentRow(
                avatar = { StackedFigures(state.agents.take(3), AvatarSize.md) }, title = "All agents", subtitle = null,
                onClick = { world.setScope(null); onDismiss() },
                trailing = if (state.scope == null) check else null,
            )
        }
        GroupedSection(header = "Agents") {
            if (state.agents.isEmpty()) SettingsEmpty("No agents yet.")
            state.agents.forEach { a ->
                AgentRow(
                    avatar = { AgentAvatar(a, AvatarSize.md) },
                    title = a.name.orEmpty(),
                    subtitle = a.title?.trim()?.takeIf { it.isNotEmpty() } ?: state.doingLine(a),
                    onClick = { world.setScope(a.id); onDismiss() },
                    trailing = if (state.scope == a.id) check else null,
                )
            }
        }
    }
}
