package io.github.nigelleong0703.juno.ui.library

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.LibraryItem
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.parseIso
import io.github.nigelleong0703.juno.ui.chat.fileTypeLine
import io.github.nigelleong0703.juno.core.userMessage
import io.github.nigelleong0703.juno.state.LibraryGroup
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.artifactRenderUrl
import io.github.nigelleong0703.juno.state.downloadLibraryFile
import io.github.nigelleong0703.juno.state.loadSpaces
import io.github.nigelleong0703.juno.state.reloadLibrary
import io.github.nigelleong0703.juno.ui.components.CapsuleBadge
import io.github.nigelleong0703.juno.ui.components.EmptyState
import io.github.nigelleong0703.juno.ui.components.JunoSheet
import io.github.nigelleong0703.juno.ui.components.JunoTextField
import io.github.nigelleong0703.juno.ui.components.ShowMore
import io.github.nigelleong0703.juno.ui.components.TabHeading
import io.github.nigelleong0703.juno.ui.components.openLink
import io.github.nigelleong0703.juno.ui.settings.connectors.SegmentedControl
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.launch

private const val GROUP_STEP = 5

/**
 * The Library tab (iOS `LibraryPage`): what the agents made, private unless shared, in Tools / Documents / Media. Uploads
 * never appear. A plain file downloads and opens in another app; a published page or app opens its sheet.
 */
@Composable
fun LibraryScreen() {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var query by remember { mutableStateOf("") }
    var limits by remember { mutableStateOf(emptyMap<LibraryGroup, Int>()) }
    var opened by remember { mutableStateOf<LibraryItem?>(null) }
    var opening by remember { mutableStateOf(emptySet<String>()) }
    var failure by remember { mutableStateOf<String?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    // The Shared filter lists the Spaces with a hosted link instead of the agents' files (owner-approved 2026-10-26).
    var shared by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { world.reloadLibrary(); world.loadSpaces() }

    val q = query.trim()
    val items = state.library
        .filter { (state.scope == null || it.createdByAgentId == state.scope) && (q.isEmpty() || it.name.orEmpty().contains(q, ignoreCase = true)) }
        .sortedByDescending { parseIso(it.createdAt) ?: java.time.Instant.MIN }
    val groups = LibraryGroup.entries.map { group -> group to items.filter { LibraryGroup.of(it) == group } }.filter { it.second.isNotEmpty() }

    fun open(item: LibraryItem) {
        if (item.render != null) {
            opened = item
            return
        }
        if (item.id in opening) return
        opening = opening + item.id
        scope.launch {
            try {
                context.openLibraryFile(world.downloadLibraryFile(item.id, item.name))
            } catch (e: Throwable) {
                if (!e.isCancellation) failure = e.userMessage
            } finally {
                opening = opening - item.id
            }
        }
    }

    PullToRefreshBox(isRefreshing = refreshing, onRefresh = { scope.launch { refreshing = true; world.reloadLibrary(); refreshing = false } }, modifier = Modifier.fillMaxSize()) {
        LazyColumn(
            Modifier.fillMaxSize().background(c.canvas),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            item(key = "heading") {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    TabHeading("Library")
                    // iOS: the magnifier sits inside the bordered field; the clear button shows once there is text.
                    JunoTextField(
                        value = query, onValueChange = { query = it; limits = emptyMap() }, label = "Search library",
                        modifier = Modifier.fillMaxWidth(),
                        leadingIcon = { Icon(JunoIcons.Search, contentDescription = null, tint = c.fgSubtle, modifier = Modifier.size(18.dp)) },
                        trailingIcon = if (query.isEmpty()) null else ({
                            Icon(JunoIcons.Close, "Clear search", tint = c.fgSubtle, modifier = Modifier.size(18.dp).clickable { query = ""; limits = emptyMap() })
                        }),
                    )
                    SegmentedControl(options = listOf(false to "All", true to "Shared"), selected = shared, onSelect = { shared = it })
                }
            }
            if (shared) item(key = "shared") { SharedSpaces() }
            if (!shared && groups.isEmpty()) {
                item(key = "empty") {
                    EmptyState(
                        JunoIcons.Library,
                        if (q.isEmpty()) "Nothing here yet" else "No matching items",
                        if (q.isEmpty()) "Documents, tools and pictures your agents make for you appear here. They stay private unless you share them."
                        else "Try another name or choose a different agent.",
                    )
                }
            }
            if (!shared) groups.forEach { (group, rows) ->
                val limit = limits[group] ?: GROUP_STEP
                item(key = "group-${group.name}") {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        // iOS PageSection: the title at 17 pt semibold.
                        Text("${group.title} · ${rows.size}", style = junoText(TextSize.Lg, FontWeight.SemiBold), color = c.fg, modifier = Modifier.padding(bottom = 4.dp))
                        rows.take(limit).forEach { row ->
                            LibraryRow(row, agentName = state.agent(row.createdByAgentId)?.name, busy = row.id in opening) { open(row) }
                        }
                        ShowMore(shown = minOf(limit, rows.size), total = rows.size, onMore = { limits = limits + (group to limit + GROUP_STEP) })
                    }
                }
            }
            failure?.let { message -> item(key = "failure") { Text(message, style = junoText(TextSize.Sm), color = JunoStatus.danger) } }
        }
    }

    opened?.let { item ->
        LibraryOpenSheet(item, onDismiss = { opened = null })
    }
}

/** One library item: a tile, its name, the kind, the agent and the age; "Shared" when a team can see it. */
@Composable
private fun LibraryRow(item: LibraryItem, agentName: String?, busy: Boolean, onOpen: () -> Unit) {
    val c = JunoTheme.colors
    val kind = if (item.render == "html") "Interactive page" else fileTypeLine(item)
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        FileTile(item)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(item.name.orEmpty(), style = junoText(TextSize.Base, FontWeight.Medium), color = c.fg, maxLines = 1)
            // iOS row: "MARKDOWN · 69 bytes · Juno · 9 min. ago".
            val line = listOfNotNull(kind, agentName, libraryAgo(item.createdAt)).filter { it.isNotEmpty() }.joinToString(" · ")
            Text(line, style = junoText(TextSize.Xs), color = c.fgSubtle, maxLines = 1)
        }
        if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = c.fgMuted)
        if (item.shared == "team") CapsuleBadge("Shared")
    }
}

/** The 44 dp tile for an item: an icon by what it is. */
@Composable
private fun FileTile(item: LibraryItem) {
    val c = JunoTheme.colors
    val icon = when (LibraryGroup.of(item)) {
        LibraryGroup.Tools -> JunoIcons.Plugins
        LibraryGroup.Media -> JunoIcons.Photo
        else -> JunoIcons.File
    }
    Box(Modifier.size(44.dp).clip(RoundedCornerShape(Radius.sm)).background(c.tile), contentAlignment = Alignment.Center) {
        Icon(icon, contentDescription = null, tint = c.fgMuted, modifier = Modifier.size(22.dp))
    }
}

/**
 * A published page, app or picture (iOS `PublishedArtifactCard` / `SpaceCard`): opened in the browser through its
 * short-lived address. The file itself can also be downloaded and opened in another app.
 */
@Composable
private fun LibraryOpenSheet(item: LibraryItem, onDismiss: () -> Unit) {
    val world = LocalWorld.current
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val c = JunoTheme.colors
    var message by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    JunoSheet(title = item.name.orEmpty().ifEmpty { "Library" }, onDismiss = onDismiss, long = true) {
        Text(
            if (item.render == "app") "An app your agent made. It opens in the browser." else "A page your agent made. It opens in the browser.",
            style = junoText(TextSize.Base), color = c.fgMuted,
        )
        TextButton(
            onClick = {
                busy = true
                message = null
                scope.launch {
                    try {
                        context.openLink(world.artifactRenderUrl(item), webOnly = true)
                    } catch (e: Throwable) {
                        if (!e.isCancellation) message = e.userMessage
                    }
                    busy = false
                }
            },
            enabled = !busy,
        ) { Text(if (busy) "Opening…" else "Open in browser", style = junoText(TextSize.Md, FontWeight.SemiBold), color = c.fg) }
        TextButton(
            onClick = {
                busy = true
                message = null
                scope.launch {
                    try {
                        context.openLibraryFile(world.downloadLibraryFile(item.id, item.name))
                    } catch (e: Throwable) {
                        if (!e.isCancellation) message = e.userMessage
                    }
                    busy = false
                }
            },
            enabled = !busy,
        ) { Text("Download and open", style = junoText(TextSize.Md), color = c.fg) }
        message?.let { Text(it, style = junoText(TextSize.Sm), color = JunoStatus.danger) }
    }
}
