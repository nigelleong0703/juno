package io.github.nigelleong0703.juno.ui.feed

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import io.github.nigelleong0703.juno.ui.components.ButtonSize
import io.github.nigelleong0703.juno.ui.uidoc.replies
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Agent
import io.github.nigelleong0703.juno.state.FeedItem
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.cardSummary
import io.github.nigelleong0703.juno.state.noteInterest
import io.github.nigelleong0703.juno.state.replyToPost
import io.github.nigelleong0703.juno.state.sendFeedback
import io.github.nigelleong0703.juno.ui.components.AgentAvatar
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.MarkdownText
import io.github.nigelleong0703.juno.ui.components.RelativeTime
import io.github.nigelleong0703.juno.ui.components.RemoteImage
import io.github.nigelleong0703.juno.ui.components.rememberCloseAction
import io.github.nigelleong0703.juno.ui.components.openLink
import io.github.nigelleong0703.juno.ui.components.sourceHost
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import io.github.nigelleong0703.juno.ui.uidoc.UiDocView
import io.github.nigelleong0703.juno.core.parseIso

/**
 * One post opened in full (iOS `FeedPostDetail`): title, picture, summary, the write-up and the UI doc, then "Was this
 * useful?". The bottom bar replies to the agent. Opened by route with the post id; closes through the back dispatcher.
 */
@Composable
fun FeedPostScreen(id: String) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    val context = LocalContext.current
    val close = rememberCloseAction()
    var forwarding by remember { mutableStateOf(false) }
    var declining by remember { mutableStateOf(false) }
    val item = state.feed.firstOrNull { it.post.id == id }
    val agent = item?.let { state.agent(it.post.agentId) }

    Column(Modifier.fillMaxSize().background(c.canvas)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = close) { Icon(JunoIcons.ChevronLeft, contentDescription = "Close", tint = c.fg) }
            Text("Post", style = junoText(TextSize.Md, FontWeight.SemiBold), color = c.fg, modifier = Modifier.weight(1f))
            if (item != null) {
                IconButton(onClick = { forwarding = true }) {
                    Icon(JunoIcons.ArrowUp, contentDescription = "Forward", tint = c.fg)
                }
            }
        }
        if (item != null) {
            Column(
                Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                PostHeader(item, agent)
                item.post.title?.takeIf { it.isNotEmpty() }?.let {
                    Text(it, style = junoText(TextSize.Xl, FontWeight.SemiBold), color = c.fg)
                }
                item.post.imageUrl?.takeIf { it.startsWith("https://") }?.let { url ->
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        RemoteImage(url, Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(Radius.lg)))
                        item.post.imageCaption?.takeIf { it.isNotEmpty() }?.let {
                            Text(it, style = junoText(TextSize.Sm), color = c.fgSubtle)
                        }
                    }
                }
                item.post.summary?.takeIf { it.isNotEmpty() }?.let { Text(it, style = junoText(TextSize.Md), color = c.fg) }
                // iOS Feed.swift: the write-up is AgentMarkdown at the body size.
                item.post.body?.takeIf { it.isNotEmpty() }?.let { MarkdownText(it, c.fg) }
                if (item.ui != null) UiDocView(item.ui)
                item.post.sourceUrl?.takeIf { it.startsWith("https://") }?.let { url ->
                    Text(
                        "Source: ${sourceHost(url)}", style = junoText(TextSize.Sm), color = c.fgMuted,
                        modifier = Modifier.clickable { context.openLink(url, webOnly = true) },
                    )
                }
                UsefulRow(
                    item = item, agentName = agent?.name ?: "your agent",
                    onUseful = { world.sendFeedback(item.post.id, "more") },
                    onNotUseful = { declining = true },
                )
                Spacer(Modifier.height(8.dp))
            }
            ReplyBar(item, agent, onReply = {
                world.replyToPost(item.post)
                close()
            })
        } else {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Text("This post is gone.", style = junoText(TextSize.Base), color = c.fgMuted)
            }
        }
    }

    if (forwarding && item != null) FeedForwardSheet(item.post) { forwarding = false }
    if (declining && item != null) FeedReasonSheet(item.post) { declining = false }
}

@Composable
private fun PostHeader(item: FeedItem, agent: Agent?) {
    val c = JunoTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        AgentAvatar(agent, size = 40.dp, animated = false, tile = true)
        Column {
            Text(agent?.name ?: "Agent", style = junoText(TextSize.Sm, FontWeight.Medium), color = c.fg)
            Text(
                RelativeTime.short(parseIso(item.post.createdAt)).let { if (it.isEmpty()) "" else "$it ago" },
                style = junoText(TextSize.Xs), color = c.fgSubtle,
            )
        }
    }
}

/** The quiet end of the page: "Useful" asks for more like it, "Not for me" asks why. */
@Composable
private fun UsefulRow(item: FeedItem, agentName: String, onUseful: () -> Unit, onNotUseful: () -> Unit) {
    val c = JunoTheme.colors
    HorizontalDivider(color = c.border)
    if (item.post.feedback == "more") {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(JunoIcons.Check, contentDescription = null, tint = c.fgMuted, modifier = Modifier.size(16.dp))
            Text("Thanks — $agentName will post more like this", style = junoText(TextSize.Sm), color = c.fgMuted)
        }
    } else {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Was this useful?", style = junoText(TextSize.Sm), color = c.fgMuted, modifier = Modifier.weight(1f))
            JunoButton("Useful", onClick = onUseful, variant = ButtonVariant.Secondary, size = ButtonSize.Sm)
            JunoButton("Not for me", onClick = onNotUseful, variant = ButtonVariant.Secondary, size = ButtonSize.Sm)
        }
    }
}

/** "Reply to <agent>…" at the bottom: opens the agent's chat with the post quoted. Only with a direct chat. */
@Composable
private fun ReplyBar(item: FeedItem, agent: Agent?, onReply: () -> Unit) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    if (state.directConversation(item.post.agentId.orEmpty()) == null) return
    val c = JunoTheme.colors
    Box(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)
            .clip(RoundedCornerShape(Radius.xl)).background(c.card)
            .border(1.dp, c.border, RoundedCornerShape(Radius.xl))
            .clickable(onClick = onReply)
            .padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
        Text("Reply to ${agent?.name ?: "agent"}…", style = junoText(TextSize.Base), color = c.fgMuted)
    }
}
