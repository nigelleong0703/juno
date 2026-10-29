package io.github.nigelleong0703.juno.ui.chat

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.ExperimentalFoundationApi
import io.github.nigelleong0703.juno.ui.components.AgentAvatar
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.nigelleong0703.juno.contract.Conversation
import io.github.nigelleong0703.juno.state.WorldState
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** What the row's long-press menu does; the list screen owns the confirmation dialog for delete. */
class RowActions(
    val onOpen: () -> Unit,
    val onPin: () -> Unit,
    val onRead: () -> Unit,
    val onMute: () -> Unit,
    val onDelete: () -> Unit,
    val onProfile: () -> Unit,
)

/** A chat row (spec 2.1): 52dp avatar, title + badge + time, a two-line subtitle, pin and unread pill; long-press for actions. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ConversationRow(conversation: Conversation, state: WorldState, actions: RowActions) {
    val c = JunoTheme.colors
    val unread = conversation.unreadCount ?: 0
    val muted = conversation.muted == true
    val pinned = conversation.pinned == true
    var menu by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier.fillMaxWidth().defaultMinSize(minHeight = 76.dp).combinedClickable(onClick = actions.onOpen, onLongClick = { menu = true })
                .padding(horizontal = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically,
        ) {
            RowAvatar(conversation, state)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                        // iOS row title: a fixed 16 pt semibold (not the 17 pt Lg token).
                        Text(state.title(conversation), color = c.fg, style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                        conversation.channel?.kind?.takeIf { it in PLATFORM_KINDS }?.let { ChannelBadge(it, 15.dp) }
                        if (muted) Icon(JunoIcons.BellOff, "Muted", tint = c.fgSubtle, modifier = Modifier.size(12.dp))
                    }
                    Text(ChatFormat.listTime(conversation.lastItemAt), color = if (unread > 0) c.fg else c.fgSubtle, style = junoText(TextSize.Sm, if (unread > 0) FontWeight.Bold else FontWeight.Normal))
                }
                Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SubtitleText(ChatListLogic.subtitle(state, conversation), Modifier.weight(1f))
                    if (pinned) Icon(JunoIcons.Pin, "Pinned", tint = c.fgSubtle, modifier = Modifier.size(14.dp))
                    if (unread > 0) Text(
                        if (unread > 99) "99+" else "$unread", color = c.primaryFg, style = junoText(TextSize.Xs, FontWeight.SemiBold),
                        modifier = Modifier.defaultMinSize(minWidth = 20.dp, minHeight = 20.dp).background(if (muted) c.fgSubtle else c.primary, CircleShape).padding(horizontal = 7.dp, vertical = 2.dp),
                    )
                }
            }
        }
        // Long-press menu anchored at the row (Material), replacing iOS swipe-to-reveal buttons.
        DropdownMenu(menu, { menu = false }) {
            DropdownMenuItem(
                text = { Text(if (pinned) "Unpin" else "Pin") },
                leadingIcon = { Icon(JunoIcons.Pin, null, tint = c.fg, modifier = Modifier.size(20.dp)) },
                onClick = { menu = false; actions.onPin() },
            )
            if (unread > 0) DropdownMenuItem(
                text = { Text("Mark as read") },
                leadingIcon = { Icon(JunoIcons.Check, null, tint = c.fg, modifier = Modifier.size(20.dp)) },
                onClick = { menu = false; actions.onRead() },
            )
            DropdownMenuItem(
                text = { Text(if (muted) "Unmute" else "Mute") },
                leadingIcon = { Icon(if (muted) JunoIcons.Bell else JunoIcons.BellOff, null, tint = c.fg, modifier = Modifier.size(20.dp)) },
                onClick = { menu = false; actions.onMute() },
            )
            if (conversation.agentIds?.isNotEmpty() == true) DropdownMenuItem(
                text = { Text("Profile") },
                leadingIcon = { Icon(JunoIcons.User, null, tint = c.fg, modifier = Modifier.size(20.dp)) },
                onClick = { menu = false; actions.onProfile() },
            )
            DropdownMenuItem(
                text = { Text("Delete", color = JunoStatus.danger) },
                leadingIcon = { Icon(JunoIcons.Trash, null, tint = JunoStatus.danger, modifier = Modifier.size(20.dp)) },
                onClick = { menu = false; actions.onDelete() },
            )
        }
    }
}

@Composable
private fun SubtitleText(s: ChatListLogic.Subtitle, modifier: Modifier) {
    val c = JunoTheme.colors
    val style = junoText(TextSize.Base)
    when (s) {
        is ChatListLogic.Subtitle.Working -> Text("● Working" + (s.title?.takeIf { it.isNotEmpty() }?.let { " · $it" } ?: ""), color = JunoStatus.success, style = style, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = modifier)
        is ChatListLogic.Subtitle.Ask -> Text("Needs you: ${s.sentence}", color = JunoStatus.warning, style = style, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = modifier)
        is ChatListLogic.Subtitle.Preview -> Text(s.text, color = c.fgSubtle, style = style, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = modifier)
        ChatListLogic.Subtitle.None -> Box(modifier)
    }
}

@Composable
private fun RowAvatar(conversation: Conversation, state: WorldState) {
    val agents = conversation.agentIds.orEmpty().mapNotNull { state.agent(it) }
    val working = state.activeRunsIn(conversation.id).any { it.parentRunId == null && (it.status == "running" || it.status == "queued") }
    Box {
        if (conversation.kind == "room") GroupAvatar(agents, 52.dp) else AgentAvatar(agents.firstOrNull(), 52.dp)
        if (working) StatusBadge(JunoStatus.success, 12.dp, Modifier.align(Alignment.BottomEnd))
    }
}
