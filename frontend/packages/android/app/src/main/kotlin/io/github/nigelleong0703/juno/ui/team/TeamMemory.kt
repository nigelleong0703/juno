package io.github.nigelleong0703.juno.ui.team

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.MemoryItemView
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.TeamLoad
import io.github.nigelleong0703.juno.state.deleteMemoryItem
import io.github.nigelleong0703.juno.state.resolveMemoryReview
import io.github.nigelleong0703.juno.state.teamList
import io.github.nigelleong0703.juno.state.updateMemoryItem
import io.github.nigelleong0703.juno.ui.components.FormTextField
import io.github.nigelleong0703.juno.ui.components.JunoSheet
import io.github.nigelleong0703.juno.ui.components.ShowMore
import io.github.nigelleong0703.juno.ui.settings.connectors.SegmentedControl
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.launch

/**
 * Memory (Team, owner-approved 2026-10-26): what the agents remember, with who it is about and where it was said, and the
 * items waiting for the owner's review (Keep or Forget). Forget removes an item for good; Edit changes its text, who it is
 * shared with and whether it is sensitive. 404 says "Coming soon", 503 says memory is unavailable right now, quietly.
 */
@Composable
internal fun TeamMemory() {
    val world = LocalWorld.current
    val scope = rememberCoroutineScope()
    var reload by remember { mutableIntStateOf(0) }
    var items by remember { mutableStateOf<TeamLoad<MemoryItemView>>(TeamLoad.Loading) }
    var waiting by remember { mutableStateOf<List<MemoryItemView>>(emptyList()) }
    var editing by remember { mutableStateOf<MemoryItemView?>(null) }

    LaunchedEffect(reload) {
        items = world.teamList<MemoryItemView>("/v1/memory/items?limit=200")
        waiting = (world.teamList<MemoryItemView>("/v1/memory/review") as? TeamLoad.Loaded<MemoryItemView>)?.items.orEmpty()
    }

    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        if (waiting.isNotEmpty()) {
            val c = JunoTheme.colors
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Waiting for your review", color = c.fgMuted, style = junoText(TextSize.Sm, FontWeight.SemiBold))
                waiting.forEach { item ->
                    MemoryRow(item) {
                        TeamAction("Keep") { scope.launch { if (world.resolveMemoryReview(item.id, keep = true)) reload++ } }
                        TeamAction("Forget") { scope.launch { if (world.resolveMemoryReview(item.id, keep = false)) reload++ } }
                    }
                }
            }
        }
        TeamListView(items, emptyText = "Nothing remembered yet", offlineText = "Memory is unavailable right now.") { list ->
            MemoryRows(list, onEdit = { editing = it }, onForget = { id -> scope.launch { if (world.deleteMemoryItem(id)) reload++ } })
        }
    }
    editing?.let { item -> EditMemorySheet(item) { changed -> editing = null; if (changed) reload++ } }
}

/** The memory list, ten at a time. */
@Composable
private fun MemoryRows(items: List<MemoryItemView>, onEdit: (MemoryItemView) -> Unit, onForget: (String) -> Unit) {
    var limit by remember { mutableIntStateOf(10) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items.take(limit).forEach { item ->
            MemoryRow(item) {
                TeamAction("Edit") { onEdit(item) }
                TeamAction("Forget") { onForget(item.id) }
            }
        }
        ShowMore(shown = minOf(limit, items.size), total = items.size, onMore = { limit += 10 })
    }
}

/** One memory item: its text, what it is about and where it was said, and its actions at the trailing end. */
@Composable
private fun MemoryRow(item: MemoryItemView, actions: @Composable RowScope.() -> Unit) {
    val c = JunoTheme.colors
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.xl)).background(c.muted.copy(alpha = 0.7f)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(item.text.orEmpty(), color = c.fg, style = junoText(TextSize.Md), maxLines = 3, overflow = TextOverflow.Ellipsis)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val about = item.about?.name?.takeIf { it.isNotEmpty() }?.let { "About $it" }
            val said = item.saidIn?.label?.takeIf { it.isNotEmpty() }?.let { "Said in $it" }
            Text(
                listOfNotNull(about, said).joinToString(" · "), color = c.fgMuted, style = junoText(TextSize.Sm),
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
            )
            actions()
        }
    }
}

/** Edits one memory item: its text, who it is shared with (owner or public), and whether it is sensitive. */
@Composable
private fun EditMemorySheet(item: MemoryItemView, onDone: (changed: Boolean) -> Unit) {
    val world = LocalWorld.current
    val scope = rememberCoroutineScope()
    val c = JunoTheme.colors
    var text by remember { mutableStateOf(item.text.orEmpty()) }
    var audience by remember { mutableStateOf(if (item.audience?.kind == "public") "public" else "owner") }
    var sensitive by remember { mutableStateOf(item.sensitive == true) }
    var saving by remember { mutableStateOf(false) }
    JunoSheet(
        title = "Edit memory", onDismiss = { onDone(false) }, primary = "Save",
        primaryEnabled = text.trim().isNotEmpty() && !saving, loading = saving,
        onPrimary = {
            saving = true
            scope.launch { onDone(world.updateMemoryItem(item.id, text.trim(), audience, sensitive)) }
        },
    ) {
        FormTextField(text, { text = it }, placeholder = "What the agents remember", minLines = 3, maxLines = 8)
        SegmentedControl(options = listOf("owner" to "Only me", "public" to "Public"), selected = audience, onSelect = { audience = it })
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Sensitive", color = c.fg, style = junoText(TextSize.Md), modifier = Modifier.weight(1f))
            Switch(checked = sensitive, onCheckedChange = { sensitive = it })
        }
    }
}
