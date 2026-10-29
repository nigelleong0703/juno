package io.github.nigelleong0703.juno.ui.agents.workspace

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.clickable
import io.github.nigelleong0703.juno.ui.components.PageScaffold
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.nav.Route
import io.github.nigelleong0703.juno.state.Fmt
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.agentsData
import io.github.nigelleong0703.juno.state.reloadLibrary
import io.github.nigelleong0703.juno.state.open
import io.github.nigelleong0703.juno.state.sentence
import io.github.nigelleong0703.juno.ui.agents.IconTile
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

@Composable
private fun EmptyState(icon: ImageVector, text: String) {
    val c = JunoTheme.colors
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(icon, null, tint = c.fgSubtle, modifier = Modifier.size(36.dp))
            Text(text, style = junoText(TextSize.Md, FontWeight.Medium), color = c.fgMuted)
        }
    }
}

/** Library items made in this chat (spec 2.13). */
@Composable
fun FilesTab(conversationId: String) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    LaunchedEffect(conversationId) { world.reloadLibrary() }
    val files = state.library.filter { it.conversationId == conversationId }
    if (files.isEmpty()) { EmptyState(JunoIcons.File, "No files in this chat yet"); return }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        items(files, key = { it.id }) { f ->
            androidx.compose.foundation.layout.Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                IconTile(JunoIcons.File)
                Column(Modifier.weight(1f)) {
                    Text(f.name.orEmpty(), style = junoText(TextSize.Md, FontWeight.Medium), color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(listOfNotNull(f.kind, Fmt.ago(f.createdAt).takeIf { it.isNotEmpty() }).joinToString(" · "), style = junoText(TextSize.Sm), color = c.fgSubtle)
                }
            }
        }
    }
}

/** Every pending request (or one agent's), newest first; each opens its detail (spec 2.12). */
@Composable
fun NeedsYouList(agentId: String? = null, onBack: (() -> Unit)? = null) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    val requests = if (agentId != null) state.pendingOf(agentId) else state.pending
    PageScaffold("Needs you", onBack) {
        if (requests.isEmpty()) { EmptyState(JunoIcons.CheckCircle, "Nothing is waiting on you"); return@PageScaffold }
        LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            items(requests, key = { it.id }) { r ->
                androidx.compose.foundation.layout.Row(Modifier.fillMaxWidth().clickable { world.open(Route.Request(r.id)) }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Icon(JunoIcons.Alert, null, tint = JunoStatus.warning)
                    Column {
                        Text(r.sentence, style = junoText(TextSize.Md, FontWeight.Medium), color = c.fg, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text("${state.agent(r.agentId)?.name.orEmpty()} · ${Fmt.requestTitle(r.kind)} · ${Fmt.ago(r.createdAt)}", style = junoText(TextSize.Sm), color = c.fgSubtle)
                    }
                }
            }
        }
    }
}
