package io.github.nigelleong0703.juno.ui.feed

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.foundation.background
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Agent
import io.github.nigelleong0703.juno.core.parseIso
import io.github.nigelleong0703.juno.state.FeedItem
import io.github.nigelleong0703.juno.state.cardSummary
import io.github.nigelleong0703.juno.ui.components.AgentAvatar
import io.github.nigelleong0703.juno.ui.components.RelativeTime
import io.github.nigelleong0703.juno.ui.components.RemoteImage
import io.github.nigelleong0703.juno.ui.components.feedCard
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import io.github.nigelleong0703.juno.ui.components.openLink

/** What the long-press menu of a post can do. [canReply] is false without a direct chat with the post's agent. */
data class FeedRowActions(
    val canReply: Boolean,
    val onOpen: () -> Unit,
    val onReply: () -> Unit,
    val onForward: () -> Unit,
    val onDecline: () -> Unit,
)

/**
 * One post as a compact card: byline, title, summary, and a square thumbnail on the right. Tap opens the post; long
 * press shows Reply, Forward, Open source and Not interested (iOS `FeedRow` + `FeedMenu`).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun FeedRow(item: FeedItem, agent: Agent?, highlighted: Boolean, actions: FeedRowActions, modifier: Modifier = Modifier) {
    val c = JunoTheme.colors
    val post = item.post
    val context = LocalContext.current
    var menuOpen by remember { mutableStateOf(false) }
    val sourceUrl = post.sourceUrl?.takeIf { it.startsWith("https://") }
    Row(
        modifier
            .feedCard(
                (if (highlighted) Modifier.border(2.dp, c.fg, RoundedCornerShape(Radius.xl)) else Modifier)
                    .combinedClickable(onClick = actions.onOpen, onLongClick = { menuOpen = true }),
            ),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                AgentAvatar(agent, size = 18.dp, animated = false, tile = true)
                Text(
                    listOf(agent?.name ?: "Agent", RelativeTime.short(parseIso(post.createdAt))).filter { it.isNotEmpty() }.joinToString(" · "),
                    style = junoText(TextSize.Xs), color = c.fgSubtle, maxLines = 1,
                )
            }
            post.title?.takeIf { it.isNotEmpty() }?.let {
                Text(it, style = junoText(TextSize.Md, FontWeight.SemiBold), color = c.fg, maxLines = 2)
            }
            post.cardSummary?.let { Text(it, style = junoText(TextSize.Sm), color = c.fgMuted, maxLines = 2) }
        }
        post.imageUrl?.takeIf { it.startsWith("https://") }?.let {
            RemoteImage(it, Modifier.size(76.dp).clip(RoundedCornerShape(10.dp)))
        }
        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
            if (actions.canReply) MenuItem("Reply", JunoIcons.Reply) { menuOpen = false; actions.onReply() }
            MenuItem("Forward…", JunoIcons.ArrowUp) { menuOpen = false; actions.onForward() }
            sourceUrl?.let { url -> MenuItem("Open source", JunoIcons.ArrowUpRight) { menuOpen = false; context.openLink(url, webOnly = true) } }
            MenuItem("Not interested", JunoIcons.ThumbDown, destructive = true) { menuOpen = false; actions.onDecline() }
        }
    }
}

@Composable
internal fun MenuItem(label: String, icon: ImageVector, destructive: Boolean = false, onClick: () -> Unit) {
    val c = JunoTheme.colors
    val ink: Color = if (destructive) io.github.nigelleong0703.juno.ui.theme.JunoStatus.danger else c.fg
    DropdownMenuItem(
        text = { Text(label, color = ink) },
        leadingIcon = { Icon(icon, contentDescription = null, tint = ink) },
        onClick = onClick,
    )
}
