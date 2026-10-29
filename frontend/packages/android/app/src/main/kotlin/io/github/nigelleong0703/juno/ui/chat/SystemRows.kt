package io.github.nigelleong0703.juno.ui.chat

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import io.github.nigelleong0703.juno.ui.components.ButtonSize
import io.github.nigelleong0703.juno.ui.components.AgentAvatar
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Icon
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Item
import io.github.nigelleong0703.juno.contract.Agent
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.acceptRole
import io.github.nigelleong0703.juno.state.agentsData
import io.github.nigelleong0703.juno.state.loadRoutines
import io.github.nigelleong0703.juno.state.dismissRole
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** Centred muted line: "<from> handed off to <to>". */
@Composable
fun HandoffRow(from: String, to: String) {
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Text("$from handed off to $to", color = JunoTheme.colors.fgSubtle, style = junoText(TextSize.Xs))
    }
}

/** A system row: icon by level (error x, warning triangle, info), the text and an optional action (Retry run / Open computer). */
@Composable
fun SystemRow(item: Item, a: ChatActions) {
    val c = JunoTheme.colors
    val (icon, tint) = when (item.level) {
        "error" -> JunoIcons.Close to JunoStatus.danger
        "warning" -> JunoIcons.Warning to JunoStatus.warning
        else -> JunoIcons.Info to c.fgSubtle
    }
    Row(Modifier.fillMaxWidth().padding(horizontal = 2.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(14.dp))
        Text(item.text.orEmpty(), color = c.fgMuted, style = junoText(TextSize.Sm), modifier = Modifier.weight(1f, fill = false))
        item.action?.let { action ->
            Text(action.label ?: "Open", color = c.fg, style = junoText(TextSize.Sm, FontWeight.SemiBold), modifier = Modifier.clickable { a.onSystemAction(item) })
        }
    }
}

/** A routine the agent created or changed: icon, name, "Routine created · Active", the trigger. Tap opens Routines. */
@Composable
fun RoutineCard(item: Item, a: ChatActions) {
    val world = LocalWorld.current
    val data by world.agentsData.collectAsState()
    val c = JunoTheme.colors
    val routine = data.routine(item.routineId.orEmpty())
    LaunchedEffect(item.routineId, routine == null) { if (routine == null) world.loadRoutines() }
    val status = if (routine?.enabled == false || routine?.status == "paused") "Paused" else "Active"
    CardTile(
        routine?.name ?: item.title ?: "Routine", Modifier.widthIn(max = 560.dp).clickable(onClick = a.onOpenRoutines),
        subtitle = listOfNotNull("Routine ${if (item.change == "updated") "updated" else "created"} · $status", routine?.trigger?.human).joinToString("\n"), chevron = true,
    ) { TileBadge(JunoIcons.Clock) }
}

/** "Posted to Feed": a compact card for a post the agent put on the Feed; it opens that post. */
@Composable
fun FeedRefCard(item: Item, a: ChatActions) {
    val c = JunoTheme.colors
    Row(
        Modifier.fillMaxWidth().widthIn(max = 560.dp).clip(RoundedCornerShape(Radius.tile)).background(c.requestCard).border(0.5.dp, c.border, RoundedCornerShape(Radius.tile))
            .clickable { item.feedPostId?.let(a.onOpenFeedPost) }.padding(10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        // The post image needs the signed feed image loader (not ported); the tile stands in.
        Box(Modifier.size(56.dp).clip(RoundedCornerShape(12.dp)).background(c.tile), contentAlignment = Alignment.Center) {
            Icon(JunoIcons.File, null, tint = c.fgSubtle)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(item.title ?: "Feed post", color = c.fg, style = junoText(TextSize.Base, FontWeight.Medium), maxLines = 2, overflow = TextOverflow.Ellipsis)
            item.summary?.takeIf { it.isNotEmpty() }?.let { Text(it, color = c.fg.copy(alpha = 0.7f), style = junoText(TextSize.Sm), maxLines = 2, overflow = TextOverflow.Ellipsis) }
            Text("Posted to Feed", color = c.fgMuted, style = junoText(TextSize.Sm))
        }
        Icon(JunoIcons.ChevronRight, null, tint = c.fgSubtle, modifier = Modifier.size(18.dp))
    }
}

/** "<agent> looks like your…": the role card with an editable name, Use this role / Not now (iOS `RoleSuggestionCard`). */
@Composable
fun RoleSuggestionCard(item: Item, agent: Agent?) {
    val world = LocalWorld.current
    val c = JunoTheme.colors
    var name by remember(item.id) { mutableStateOf(item.title.orEmpty()) }
    val at = io.github.nigelleong0703.juno.core.parseIso(item.suggestionAt)
    val mine = io.github.nigelleong0703.juno.core.parseIso(agent?.roleSuggestion?.createdAt)
    val pending = at != null && mine != null && kotlin.math.abs(at.epochSecond - mine.epochSecond) < 1
    val dismissed = io.github.nigelleong0703.juno.core.parseIso(agent?.roleSuggestionDismissedAt)?.let { d -> at == null || d >= at } == true || agent?.title?.trim() in listOf("", "Agent", "New agent", null)
    MessageColumn(trailing = false) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.Top) {
            AgentAvatar(agent, 24.dp, Modifier.padding(top = 2.dp), animated = false)
            Column(
                Modifier.weight(1f).clip(RoundedCornerShape(Radius.xxl)).background(c.bubbleAgent).padding(horizontal = 12.dp, vertical = 8.dp),
            ) {
                Text("${agent?.name ?: "Your agent"} looks like your…", color = c.fgMuted, style = junoText(TextSize.Sm))
                if (pending) BasicTextField(
                    name, { name = it }, singleLine = true, textStyle = junoText(TextSize.Lg, FontWeight.SemiBold).copy(color = c.bubbleAgentFg), cursorBrush = SolidColor(c.fg),
                    modifier = Modifier.padding(top = 6.dp).fillMaxWidth().clip(RoundedCornerShape(Radius.md)).background(c.inputBg).border(1.dp, c.border, RoundedCornerShape(Radius.md)).padding(horizontal = 10.dp, vertical = 8.dp),
                ) else Text(item.title.orEmpty(), color = c.bubbleAgentFg, style = junoText(TextSize.Lg, FontWeight.SemiBold), modifier = Modifier.padding(top = 2.dp))
                item.description?.takeIf { it.isNotEmpty() }?.let { Text(it, color = c.fgMuted, style = junoText(TextSize.Sm), modifier = Modifier.padding(top = 4.dp)) }
                Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (pending && agent != null) {
                        JunoButton("Use this role", { world.acceptRole(agent.id, name) }, size = ButtonSize.Regular)
                        JunoButton("Not now", { world.dismissRole(agent.id) }, variant = ButtonVariant.Ghost, size = ButtonSize.Regular)
                    } else {
                        Box(Modifier.size(6.dp).background(if (dismissed) c.fgSubtle else JunoStatus.success, CircleShape))
                        Text(if (dismissed) "Not now" else "Role set: ${agent?.title ?: item.title.orEmpty()}", color = c.fgMuted, style = junoText(TextSize.Xs))
                    }
                }
            }
        }
    }
}
