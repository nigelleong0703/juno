package io.github.nigelleong0703.juno.ui.agents.workspace

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.nav.Route
import io.github.nigelleong0703.juno.state.Fmt
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.open
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

private enum class Section(val title: String) { Computer("Computer"), Files("Files") }

/**
 * The workspace as a large sheet (iOS `WorkspaceView`): Computer | Files, the agent's name and status on top (tap opens
 * the agent page), an agent menu only when the chat has more than one agent. [onDismiss] closes it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkspaceSheet(conversationId: String, agentId: String, onDismiss: () -> Unit) {
    val world = LocalWorld.current
    ModalBottomSheet(
        onDismissRequest = onDismiss, containerColor = JunoTheme.colors.canvas, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        shape = RoundedCornerShape(topStart = 32.dp, topEnd = 32.dp),
    ) {
        Box(Modifier.fillMaxWidth().fillMaxHeight(0.92f)) {
            WorkspaceContent(conversationId, agentId, onClose = onDismiss, onOpenAgent = { onDismiss(); world.open(Route.Agent(it)) })
        }
    }
}

/** The workspace as a pushed page (route `Route.Workspace`). */
@Composable
fun WorkspaceScreen(conversationId: String, agentId: String, onBack: () -> Unit) {
    val world = LocalWorld.current
    Box(Modifier.fillMaxSize().background(JunoTheme.colors.canvas)) {
        WorkspaceContent(conversationId, agentId, onClose = onBack, onOpenAgent = { world.open(Route.Agent(it)) })
    }
}

@Composable
private fun WorkspaceContent(conversationId: String, initialAgent: String, onClose: () -> Unit, onOpenAgent: (String) -> Unit) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    var agentId by remember { mutableStateOf(initialAgent) }
    var section by remember { mutableStateOf(Section.Computer) }
    var menu by remember { mutableStateOf(false) }
    val agent = state.agent(agentId)
    val members = state.conversation(conversationId)?.agentIds.orEmpty().mapNotNull { state.agent(it) }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            if (members.size > 1) Box {
                IconButton({ menu = true }) { Icon(JunoIcons.Users, "Agent", tint = c.fg) }
                DropdownMenu(menu, { menu = false }, containerColor = c.card) {
                    members.forEach { m -> DropdownMenuItem(text = { Text(m.name.orEmpty()) }, onClick = { agentId = m.id; menu = false }) }
                }
            } else Box(Modifier.padding(start = 48.dp))
            Column(Modifier.weight(1f).clickable { onOpenAgent(agentId) }, horizontalAlignment = Alignment.CenterHorizontally) {
                Text(agent?.name ?: "Agent", style = junoText(TextSize.Sm, FontWeight.SemiBold), color = c.fg, maxLines = 1)
                Text(agent?.status?.let(Fmt::status).orEmpty(), style = junoText(TextSize.Xs), color = c.fgMuted, maxLines = 1, textAlign = TextAlign.Center)
            }
            IconButton(onClose) { Icon(JunoIcons.Close, "Close", tint = c.fg) }
        }
        Row(Modifier.padding(horizontal = 16.dp).padding(bottom = 8.dp).fillMaxWidth().height(36.dp).clip(RoundedCornerShape(10.dp)).background(c.muted).padding(2.dp)) {
            Section.entries.forEach { s ->
                Box(
                    Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(8.dp)).background(if (s == section) c.card else c.muted).clickable { section = s },
                    contentAlignment = Alignment.Center,
                ) { Text(s.title, style = junoText(TextSize.Base, FontWeight.Medium), color = if (s == section) c.fg else c.fgMuted) }
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when (section) {
                Section.Computer -> ComputerPanel(agentId)
                Section.Files -> FilesTab(conversationId)
            }
        }
    }
}
