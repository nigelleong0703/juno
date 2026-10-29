package io.github.nigelleong0703.juno.ui.chat

import io.github.nigelleong0703.juno.ui.components.JunoIcons
import androidx.compose.ui.graphics.luminance

import io.github.nigelleong0703.juno.ui.components.ButtonSize
import io.github.nigelleong0703.juno.ui.uidoc.replies
import io.github.nigelleong0703.juno.ui.uidoc.parsed
import io.github.nigelleong0703.juno.ui.uidoc.UiDocView
import io.github.nigelleong0703.juno.state.Fmt
import io.github.nigelleong0703.juno.ui.components.AgentAvatar
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Citation
import io.github.nigelleong0703.juno.contract.Item
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.components.MarkdownText
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** Message width rule: max-w min(80%, 560) of the row (ui/ai/message.tsx). */
@Composable
fun MessageColumn(trailing: Boolean, content: @Composable () -> Unit) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val width: Dp = minOf(maxWidth * 0.8f, 560.dp)
        Column(Modifier.widthIn(max = width).align(if (trailing) Alignment.CenterEnd else Alignment.CenterStart), horizontalAlignment = if (trailing) Alignment.End else Alignment.Start) { content() }
    }
}

/** Dark ink on a light fill, white on a dark one (iOS `onColor`: relative luminance above 0.4 takes #141414). */
fun onColor(fill: androidx.compose.ui.graphics.Color): androidx.compose.ui.graphics.Color =
    if (fill.luminance() > 0.4f) androidx.compose.ui.graphics.Color(0xFF141414) else androidx.compose.ui.graphics.Color.White

/** The quoted text inside a bubble: bar on the left, muted text, two lines (iOS `QuoteCard`). */
@Composable
fun QuoteCard(text: String, ink: androidx.compose.ui.graphics.Color) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.md)).background(ink.copy(alpha = 0.1f)).padding(horizontal = 8.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.size(width = 3.dp, height = 18.dp).background(ink.copy(alpha = 0.55f), CircleShape))
        Text(text, color = ink.copy(alpha = 0.75f), style = junoText(TextSize.Sm), maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

/** One emoji chip on a bubble corner: mine (tap to remove) overrides the agent's; the agent's shows when I have none. */
@Composable
private fun ReactionChip(emoji: String?, trailing: Boolean, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val c = JunoTheme.colors
    Box(modifier) {
        content()
        if (emoji != null) Text(
            emoji, style = junoText(TextSize.Sm),
            modifier = Modifier.align(if (trailing) Alignment.BottomEnd else Alignment.BottomStart).offset(x = if (trailing) 6.dp else (-6).dp, y = 12.dp)
                .clip(CircleShape).background(c.card).border(0.5.dp, c.border, CircleShape).padding(horizontal = 6.dp, vertical = 2.dp),
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun UserBubble(item: Item, showAuthor: Boolean, values: RowValues, a: ChatActions) {
    val c = JunoTheme.colors
    val isSelf = values.isSelf
    // A platform stranger is someone else in the room: an incoming (left, grey) bubble, like a group chat.
    val stranger = item.channelSender?.role == "stranger"
    val failed = values.failed
    val sending = values.sending
    // iOS Items.swift: ink = stranger ? agent ink : onColor(accent) ?? bubbleUserFg; fill = accent ?? bubbleUser.
    val ink = if (stranger) c.bubbleAgentFg else a.accent?.let(::onColor) ?: c.bubbleUserFg
    MessageColumn(trailing = !stranger) {
        Column(horizontalAlignment = if (stranger) Alignment.Start else Alignment.End, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (stranger) Text(item.channelSender?.name?.takeIf { it.isNotEmpty() } ?: "Someone", color = c.fgSubtle, style = junoText(TextSize.Xs, FontWeight.Medium), modifier = Modifier.padding(start = 2.dp))
            else if (showAuthor && !isSelf) Text(values.agent?.name ?: "Teammate", color = c.fgSubtle, style = junoText(TextSize.Xs, FontWeight.Medium), modifier = Modifier.padding(end = 2.dp))
            val files = item.attachments.orEmpty()
            if (files.isNotEmpty()) Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                files.forEach { f ->
                    Row(
                        Modifier.clip(RoundedCornerShape(Radius.md)).background(c.card).border(1.dp, c.border, RoundedCornerShape(Radius.md)).padding(horizontal = 8.dp, vertical = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(if (f.kind == "image") JunoIcons.Photo else JunoIcons.File, null, tint = c.fgMuted, modifier = Modifier.size(12.dp))
                        Text(f.name.orEmpty(), color = c.fgMuted, style = junoText(TextSize.Xs), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 160.dp))
                    }
                }
            }
            val text = item.text.orEmpty()
            if (text.isNotEmpty()) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (failed != null) Icon(JunoIcons.Alert, "Not sent", tint = JunoStatus.danger, modifier = Modifier.size(20.dp))
                    val (quote, body) = Quote.split(text).let { it.quote to it.body }
                    ReactionChip(a.reactions[item.id] ?: item.reaction, trailing = !stranger) {
                        MessageMenuAnchor(item, a, failed = failed != null) { onLongPress ->
                            Column(
                                Modifier.alpha(if (sending) 0.6f else 1f).clip(RoundedCornerShape(Radius.xxl)).background(if (stranger) c.bubbleAgent else a.accent ?: c.bubbleUser)
                                    .combinedClickable(onClick = {}, onLongClick = onLongPress).padding(horizontal = 12.dp, vertical = 7.dp),
                                verticalArrangement = Arrangement.spacedBy(6.dp),
                            ) {
                                quote?.let { QuoteCard(it, ink) }
                                if (body.isNotEmpty()) MarkdownText(body, ink)
                            }
                        }
                    }
                }
                // A message that did not go out offers Retry / Delete under it, with the reason.
                if (failed != null) Column(horizontalAlignment = Alignment.End) {
                    Text(failed, color = JunoStatus.danger, style = junoText(TextSize.Xs))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        JunoButton("Retry", { a.onRetry(item) }, variant = ButtonVariant.Ghost, size = ButtonSize.Sm)
                        JunoButton("Delete", { a.onDiscard(item) }, variant = ButtonVariant.Ghost, size = ButtonSize.Sm)
                    }
                }
                item.source?.kind?.takeIf { it in PLATFORM_KINDS }?.let { kind -> ChannelMarker("${Fmt.time(item.at)} · via ${platformName(kind)}", kind) }
            }
        }
    }
}

/** The tiny line under a message that crossed a messaging platform ("10:42 · via Slack", "Sent to Telegram"). */
@Composable
fun ChannelMarker(text: String, kind: String) {
    Row(Modifier.padding(horizontal = 2.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        ChannelBadge(kind, 11.dp)
        Text(text, color = JunoTheme.colors.fgSubtle, style = junoText(TextSize.Xs))
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun AgentBubble(item: Item, showAuthor: Boolean, values: RowValues, a: ChatActions) {
    val c = JunoTheme.colors
    val agent = values.agent
    MessageColumn(trailing = false) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (showAuthor) Row(Modifier.padding(start = 2.dp).clickable { item.agentId?.let(a.onOpenAgent) }, horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                AgentAvatar(agent, 18.dp, animated = false)
                Text(agent?.name ?: "Agent", color = c.fgMuted, style = junoText(TextSize.Xs, FontWeight.Medium))
            }
            val ui = item.ui
            // `markdown` is the lead-in, or the card's own text fallback when the agent said nothing else: then only the card shows.
            val said = item.markdown.orEmpty().trim()
            if (ui == null || (said.isNotEmpty() && said != ui.text.orEmpty().trim())) {
                val (quote, body) = Quote.split(item.markdown.orEmpty()).let { it.quote to it.body }
                // Only citations that link somewhere are sources (a memory citation has no page to open).
                val sources = item.citations.orEmpty().filter { !it.url.isNullOrEmpty() }
                ReactionChip(a.reactions[item.id] ?: item.reaction, trailing = false) {
                    MessageMenuAnchor(item, a, failed = values.failed != null) { onLongPress ->
                        Column(
                            Modifier.clip(RoundedCornerShape(Radius.xxl)).background(c.bubbleAgent).combinedClickable(onClick = {}, onLongClick = onLongPress).padding(horizontal = 12.dp, vertical = 6.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            quote?.let { QuoteCard(it, c.bubbleAgentFg) }
                            // No inline selection: a long press is the message menu (Copy), as on iOS; selection would take it too.
                            MarkdownText(body, c.bubbleAgentFg)
                            if (sources.isNotEmpty() && !values.hidesSources) SourcesPill(sources)
                        }
                    }
                }
                item.replyTo?.kind?.takeIf { it in PLATFORM_KINDS }?.let { ChannelMarker("Sent to ${platformName(it)}", it) }
            }
            if (ui != null && ui.blocks.orEmpty().any { it.type != "replies" }) UiDocView(ui)
            if (values.repliesOpen) ui?.parsed()?.replies?.takeIf { it.isNotEmpty() }?.let { replies ->
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) { replies.forEach { ReplyChip(it) { a.onSend(it) } } }
            }
            values.footerRun?.let { run -> RunFooter(run, values.footerMs) { a.onOpenSteps(run.id) } }
        }
    }
}

/** "Sources" under a reply: up to three overlapping dots and the label; tapping lists every source. */
@Composable
private fun SourcesPill(citations: List<Citation>) {
    val c = JunoTheme.colors
    var open by remember { mutableStateOf(false) }
    Row(Modifier.clickable { open = true }.padding(vertical = 2.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(horizontalArrangement = Arrangement.spacedBy((-5).dp)) { citations.take(3).forEach { SourceMark(it.url, 16.dp) } }
        Text("Sources", color = c.fgMuted, style = junoText(TextSize.Xs))
    }
    if (open) ChatSheet({ open = false }, "Sources") {
        val uri = LocalUriHandler.current
        citations.forEach { cit ->
            Row(Modifier.fillMaxWidth().clickable { cit.url?.let { runCatching { uri.openUri(it) } } }.padding(vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                SourceMark(cit.url, 28.dp)
                Column {
                    Text(cit.title ?: host(cit.url), color = c.fg, style = junoText(TextSize.Base, FontWeight.Medium), maxLines = 2)
                    Text(host(cit.url), color = c.fgMuted, style = junoText(TextSize.Xs), maxLines = 1)
                }
            }
        }
    }
}

private fun host(url: String?) = url?.substringAfter("://", "")?.substringBefore('/')?.removePrefix("www.").orEmpty()

/** A source's mark: a link glyph on a tile (site favicons are not fetched on Android yet). */
@Composable
private fun SourceMark(url: String?, size: Dp) {
    Box(Modifier.size(size).clip(CircleShape).background(JunoTheme.colors.tile).border(1.5.dp, JunoTheme.colors.bubbleAgent, CircleShape), contentAlignment = Alignment.Center) {
        Icon(JunoIcons.Link, null, tint = JunoTheme.colors.fgSubtle, modifier = Modifier.size(size * 0.6f))
    }
}

/** A quick reply: a full-width outlined chip; tapping sends the label as my message. */
@Composable
private fun ReplyChip(label: String, onClick: () -> Unit) {
    val c = JunoTheme.colors
    Text(
        label, color = c.fg, style = junoText(TextSize.Base, FontWeight.Medium),
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.xl)).border(1.dp, c.border, RoundedCornerShape(Radius.xl)).clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 10.dp),
    )
}
