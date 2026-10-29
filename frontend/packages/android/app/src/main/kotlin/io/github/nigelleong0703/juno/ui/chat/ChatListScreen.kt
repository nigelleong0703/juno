package io.github.nigelleong0703.juno.ui.chat

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.layout
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Conversation
import io.github.nigelleong0703.juno.nav.Route
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.deleteConversation
import io.github.nigelleong0703.juno.state.markConversationRead
import io.github.nigelleong0703.juno.state.open
import io.github.nigelleong0703.juno.state.openChat
import io.github.nigelleong0703.juno.state.setConversationFlag
import io.github.nigelleong0703.juno.ui.shell.CircleIcon
import io.github.nigelleong0703.juno.ui.shell.TabTopRow
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.launch

/**
 * The Chat tab (owner-approved 2026-10-26): the chat list alone. Today, with its Needs you, Progress, Updates and Ideas,
 * is the first tab now, so no header or suggestion cards sit above the chats here: one scrolling list of the pinned
 * filter chips and the chats. Every navigation defaults to `world.open(Route...)` / `world.openChat`, so the shell handles
 * it; pass a lambda to override.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ChatListScreen(
    modifier: Modifier = Modifier,
    onOpenConversation: ((conversationId: String) -> Unit)? = null,
    onOpenAgent: ((agentId: String) -> Unit)? = null,
    onOpenSearch: (() -> Unit)? = null,
    onNewAgent: (() -> Unit)? = null,
) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    var filter by remember { mutableStateOf<ChatFilter>(ChatFilter.All) }
    var showNew by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<Conversation?>(null) }

    val open: (String) -> Unit = { id -> onOpenConversation?.invoke(id) ?: world.openChat(id) }
    val agent: (String) -> Unit = { id -> onOpenAgent?.invoke(id) ?: world.open(Route.Agent(id)) }
    val newAgent = { onNewAgent?.invoke() ?: world.open(Route.NewAgent) }

    val rows = remember(state.conversations, state.requests, state.runs, filter) { ChatListLogic.visible(state, filter) }
    val platforms = remember(state.conversations) { ChatListLogic.platforms(state) }
    val effective = if (filter is ChatFilter.Platform && (filter as ChatFilter.Platform).kind !in platforms) ChatFilter.All else filter

    // iOS: the list runs from the top of the screen, under the status bar and the floating buttons; it starts below the
    // buttons (contentPadding), so the sticky chips stop under them.
    val topInset = WindowInsets.safeDrawing.asPaddingValues().calculateTopPadding()
    val headEnd = topInset + 52.dp // the top row: 8 dp top padding + 44 dp circle buttons

    Box(modifier.fillMaxSize().bleedUp(topInset).background(c.canvas)) {
        PullToRefreshBox(isRefreshing = refreshing, onRefresh = { scope.launch { refreshing = true; world.refreshAgents(); refreshing = false } }, modifier = Modifier.fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize(), state = listState, contentPadding = PaddingValues(top = headEnd)) {
                stickyHeader(key = "chips", contentType = "chips") {
                    FilterChips(effective, platforms, state.needsYou.size) { picked -> filter = picked }
                }
                if (rows.isEmpty()) item(key = "empty", contentType = "empty") { EmptyList(effective) }
                else items(rows, key = { it.id }, contentType = { "conversation" }) { conversation ->
                    ConversationRow(
                        conversation, state,
                        RowActions(
                            onOpen = { open(conversation.id) },
                            onPin = { world.setConversationFlag(conversation.id, pinned = conversation.pinned != true) },
                            onRead = { world.markConversationRead(conversation.id) },
                            onMute = { world.setConversationFlag(conversation.id, muted = conversation.muted != true) },
                            onDelete = { deleting = conversation },
                            onProfile = { conversation.agentIds?.firstOrNull()?.let(agent) },
                        ),
                    )
                    RowDivider()
                }
                if (state.conversations.size == 1 && effective == ChatFilter.All) item(key = "another", contentType = "another") { TalkToAnother { showNew = true } }
            }
        }
        // Scrolled content fades out under the bar (iOS scroll-edge); at rest nothing covers the list.
        Box(
            Modifier.fillMaxWidth().height(headEnd + 12.dp)
                .graphicsLayer { alpha = (listState.scrolledPx() / 12.dp.toPx()).coerceIn(0f, 1f) }
                .background(Brush.verticalGradient(0f to c.canvas, headEnd.value / (headEnd.value + 12f) to c.canvas, 1f to c.canvas.copy(alpha = 0f))),
        )
        Box(Modifier.fillMaxWidth().padding(top = topInset)) {
            TabTopRow {
                // iOS order: search, then compose at the trailing end.
                CircleIcon(JunoIcons.Search, "Search") { onOpenSearch?.invoke() ?: world.open(Route.Search) }
                CircleIcon(JunoIcons.Compose, "New chat") { showNew = true }
            }
        }
    }

    if (showNew) NewChatSheet(onDismiss = { showNew = false }, onOpenChat = { showNew = false; open(it) }, onNewAgent = { showNew = false; newAgent() })
    deleting?.let { conversation ->
        AlertDialog(
            onDismissRequest = { deleting = null }, title = { Text("Delete this chat?") }, text = { Text("The messages in it are removed for good.") },
            confirmButton = { TextButton({ world.deleteConversation(conversation.id); deleting = null }) { Text("Delete", color = JunoStatus.danger) } },
            dismissButton = { TextButton({ deleting = null }) { Text("Cancel") } },
        )
    }
}

/** How far the list has scrolled, in px; past its first row it reads as far, so the top fade is solid. */
private fun LazyListState.scrolledPx(): Float = if (firstVisibleItemIndex == 0) firstVisibleItemScrollOffset.toFloat() else Float.MAX_VALUE

/** Lays the content out [px] higher than its slot (into the status bar), keeping the slot's own size. */
private fun Modifier.bleedUp(px: Dp) = layout { measurable, constraints ->
    val extra = px.roundToPx()
    val placeable = measurable.measure(Constraints.fixed(constraints.maxWidth, constraints.maxHeight + extra))
    layout(constraints.maxWidth, constraints.maxHeight) { placeable.place(0, -extra) }
}

@Composable
private fun RowDivider() {
    Box(Modifier.padding(start = 80.dp).fillMaxWidth().height(0.5.dp).background(JunoTheme.colors.border))
}

/** The pinned chips: All, Unread, Needs you (+count and a warning dot), Groups, one per platform that has chats. */
@Composable
private fun FilterChips(selected: ChatFilter, platforms: List<String>, needsYou: Int, onSelect: (ChatFilter) -> Unit) {
    val c = JunoTheme.colors
    Row(
        Modifier.fillMaxWidth().background(c.canvas).horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        (ChatFilter.base + platforms.map { ChatFilter.Platform(it) }).forEach { f ->
            val on = selected == f
            val badge = f == ChatFilter.NeedsYou && needsYou > 0
            Row(
                Modifier.height(28.dp).clip(CircleShape).background(if (on) c.primary else c.muted).clickable { onSelect(f) }.padding(horizontal = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                if (f is ChatFilter.Platform) ChannelBadge(f.kind, 16.dp)
                Text(f.title, color = if (on) c.primaryFg else c.fg, style = junoText(TextSize.Sm, FontWeight.Medium))
                if (badge) {
                    Box(Modifier.size(7.dp).background(JunoStatus.warning, CircleShape))
                    Text("$needsYou", color = if (on) c.primaryFg else c.fg, style = junoText(TextSize.Sm, FontWeight.SemiBold))
                }
            }
        }
    }
}

@Composable
private fun EmptyList(filter: ChatFilter) {
    Box(Modifier.fillMaxWidth().defaultMinSize(minHeight = 320.dp), contentAlignment = Alignment.Center) {
        Text(if (filter == ChatFilter.All) "Nothing here" else "No results", color = JunoTheme.colors.fgMuted, style = junoText(TextSize.Md))
    }
}

/** A faint row under the only chat: another agent to talk to. */
@Composable
private fun TalkToAnother(onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 18.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("Talk to another agent", color = JunoTheme.colors.fgSubtle, style = junoText(TextSize.Base))
        Icon(JunoIcons.ChevronRight, null, tint = JunoTheme.colors.fgSubtle, modifier = Modifier.size(16.dp))
    }
}
