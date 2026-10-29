package io.github.nigelleong0703.juno.ui.chat

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Conversation
import io.github.nigelleong0703.juno.state.Fmt
import io.github.nigelleong0703.juno.state.WorldState
import io.github.nigelleong0703.juno.ui.components.AgentAvatar
import io.github.nigelleong0703.juno.ui.theme.AvatarSize
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/**
 * The presence line under a direct chat's name: "Reconnecting…" (stream down while busy, past the grace period), then
 * "Working…" or the agent's doing-line, then its status. Groups and platform chats have none.
 */
fun presenceLine(state: WorldState, c: Conversation, reconnecting: Boolean): String? {
    if (c.kind != "direct" || c.isChannel()) return null
    val agentId = c.agentIds?.firstOrNull() ?: return null
    val agent = state.agent(agentId)
    val busy = state.activeRunsIn(c.id).any { it.parentRunId == null && (it.status == "running" || it.status == "queued") } || agent?.status == "working"
    if (reconnecting && busy) return "Reconnecting…"
    if (busy) return state.doing[agentId]?.takeIf { it.isNotEmpty() }?.let(StepText::progressive) ?: "Working…"
    return agent?.status?.let { Fmt.status(it) }
}

private fun Conversation.isChannel() = channel != null

/**
 * The floating header over the transcript, as the iPhone chat (no bar): a circular back button top-left, the agent
 * avatar centred with a "Name ⌄" chip and presence line under it (tap = agent card; group = member menu), and a
 * circular Computer button top-right. The transcript scrolls under it. Flat opaque surfaces with a hairline and a soft
 * shadow stand in for liquid glass.
 */
@Composable
fun ConversationHeader(
    conversation: Conversation,
    state: WorldState,
    reconnecting: Boolean,
    onBack: () -> Unit,
    onOpenAgent: (String) -> Unit,
    onOpenComputer: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    val c = JunoTheme.colors
    val agents = conversation.agentIds.orEmpty().mapNotNull { state.agent(it) }
    val isRoom = conversation.kind == "room"
    var menu by remember { mutableStateOf(false) }
    val needsYou = state.needsYouIn(conversation.id).isNotEmpty()
    val first = agents.firstOrNull()
    // iOS: a group or platform chat shows its title; a direct chat shows the agent's name.
    val name = if (isRoom || conversation.channel != null) state.title(conversation) else first?.name ?: state.title(conversation)
    Box(modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            FloatingCircle(onClick = onBack) { Icon(JunoIcons.ChevronLeft, "Back", tint = c.fg, modifier = Modifier.size(22.dp)) }
            Spacer(Modifier.weight(1f))
            if (onOpenComputer != null) FloatingCircle(onClick = onOpenComputer) {
                Icon(JunoIcons.Computer, "Computer", tint = c.fg, modifier = Modifier.size(22.dp))
            }
        }
        Box(Modifier.align(Alignment.TopCenter).padding(top = 8.dp)) {
            Column(
                Modifier.clickable { if (isRoom) menu = true else first?.let { onOpenAgent(it.id) } },
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                // The 88 dp disc (AvatarSize.chatHeader) holds the avatar at 80 dp, as the iPhone does.
                // The disc clips its avatar; the dot sits outside that clip, at the top-trailing corner (iOS overlay).
                Box(Modifier.size(AvatarSize.chatHeader)) {
                    Box(
                        Modifier.matchParentSize().shadow(4.dp, CircleShape).clip(CircleShape).background(c.card)
                            .border(0.5.dp, c.border, CircleShape),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (isRoom) GroupAvatar(agents, AvatarSize.chatHeader - 8.dp) else AgentAvatar(first, AvatarSize.chatHeader - 8.dp)
                    }
                    // iOS Conversation: the AgentDot (12pt) on a canvas disc with 3pt padding, at the avatar's top-trailing edge.
                    if (!isRoom && (needsYou || first?.status == "working")) Box(Modifier.align(Alignment.TopEnd).clip(CircleShape).background(c.canvas).padding(3.dp)) {
                        AgentDot(first, needsYou, 12.dp)
                    }
                }
                // The chip overlaps the avatar's lower edge, as on iPhone.
                Column(
                    Modifier.offset(y = (-12).dp).shadow(3.dp, RoundedCornerShape(50)).clip(RoundedCornerShape(50)).background(c.card)
                        .border(0.5.dp, c.border, RoundedCornerShape(50)).padding(horizontal = 12.dp, vertical = 5.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(name, color = c.fg, style = junoText(TextSize.Sm, FontWeight.Medium), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 200.dp))
                        conversation.channel?.kind?.let { ChannelBadge(it, 14.dp) }
                        Icon(JunoIcons.ChevronDown, null, tint = c.fgMuted, modifier = Modifier.size(9.dp))
                    }
                    presenceLine(state, conversation, reconnecting)?.let {
                        Text(it, color = if (it == "Reconnecting…") JunoStatus.warning else c.fgSubtle, style = junoText(TextSize.Xs), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            DropdownMenu(menu, { menu = false }) {
                agents.forEach { a -> DropdownMenuItem(text = { Text(a.name ?: a.id) }, onClick = { menu = false; onOpenAgent(a.id) }) }
            }
        }
    }
}

/** A 44 dp floating circle: opaque card fill, hairline border, soft shadow (the iPhone glass circle without blur). */
@Composable
private fun FloatingCircle(onClick: () -> Unit, content: @Composable () -> Unit) {
    Box(
        Modifier.size(44.dp).shadow(4.dp, CircleShape).clip(CircleShape).background(JunoTheme.colors.card)
            .border(0.5.dp, JunoTheme.colors.border, CircleShape).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { content() }
}
