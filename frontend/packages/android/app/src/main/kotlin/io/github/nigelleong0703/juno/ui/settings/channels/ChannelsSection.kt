package io.github.nigelleong0703.juno.ui.settings.channels

import io.github.nigelleong0703.juno.ui.components.GroupedPage
import io.github.nigelleong0703.juno.ui.components.GroupedSection
import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.background
import io.github.nigelleong0703.juno.ui.components.openLink
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.state.ChannelView
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage
import io.github.nigelleong0703.juno.state.ChannelLinks
import io.github.nigelleong0703.juno.state.ChannelPlatform
import io.github.nigelleong0703.juno.state.ChannelTone
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.channelLabel
import io.github.nigelleong0703.juno.state.channelStatusLine
import io.github.nigelleong0703.juno.state.disconnectChannel
import io.github.nigelleong0703.juno.state.refreshChannels
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.settings.SettingsEmpty
import io.github.nigelleong0703.juno.ui.settings.SettingsError
import io.github.nigelleong0703.juno.ui.settings.ShowMoreButton
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.launch

private const val CAP = 3

/**
 * "Where to find <agent>" on the agent profile: its connected channels (capped at [CAP], then Show more), a Connect button
 * that opens [AddChannelSheet], and disconnect. The section loads the list itself.
 */
@Composable
fun ChannelsSection(agentId: String, agentName: String, modifier: Modifier = Modifier) {
    val world = LocalWorld.current
    val scope = rememberCoroutineScope()
    var channels by remember(agentId) { mutableStateOf<List<ChannelView>?>(null) }
    var error by remember(agentId) { mutableStateOf<String?>(null) }
    var showAll by rememberSaveable(agentId) { mutableStateOf(false) }
    var adding by rememberSaveable(agentId) { mutableStateOf(false) }
    var disconnecting by remember(agentId) { mutableStateOf<ChannelView?>(null) }

    suspend fun attempt(block: suspend () -> Unit) {
        try {
            block()
            error = null
        } catch (e: Throwable) {
            if (!e.isCancellation) error = e.userMessage
        }
    }
    suspend fun fetch() = attempt { channels = world.refreshChannels(agentId) }
    LaunchedEffect(agentId) { fetch() }

    val all = channels.orEmpty()
    val shown = if (showAll) all else all.take(CAP)
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        GroupedSection(header = "Where to find $agentName") {
            if (channels != null && all.isEmpty()) SettingsEmpty("Not on any messaging app yet.")
            shown.forEach { channel -> ChannelRow(channel, onDisconnect = { disconnecting = channel }) }
            if (all.size > CAP) ShowMoreButton(if (showAll) "Show fewer" else "Show ${all.size - CAP} more") { showAll = !showAll }
        }
        error?.let { SettingsError(it) }
        JunoButton(text = "Connect", onClick = { adding = true }, variant = ButtonVariant.Secondary, modifier = Modifier.fillMaxWidth())
    }

    if (adding) {
        AddChannelSheet(agentId = agentId, onDismiss = {
            adding = false
            scope.launch { fetch() }
        })
    }
    disconnecting?.let { channel ->
        val c = JunoTheme.colors
        AlertDialog(
            onDismissRequest = { disconnecting = null },
            containerColor = c.card,
            title = { Text("Disconnect ${channelLabel(channel)}?", style = junoText(TextSize.Lg, FontWeight.SemiBold), color = c.fg) },
            text = { Text("This agent stops answering there. You can connect it again later.", style = junoText(TextSize.Base), color = c.fgMuted) },
            confirmButton = {
                TextButton(onClick = {
                    disconnecting = null
                    scope.launch { attempt { world.disconnectChannel(agentId, channel); channels = world.refreshChannels(agentId) } }
                }) { Text("Disconnect", color = JunoStatus.danger) }
            },
            dismissButton = { TextButton(onClick = { disconnecting = null }) { Text("Cancel", color = c.fgMuted) } },
        )
    }
}

/** The channels page for a pushed route: the same section in a settings page. */
@Composable
fun ChannelsScreen(agentId: String, agentName: String, onBack: () -> Unit) {
    GroupedPage(title = "Channels", onBack = onBack) {
        ChannelsSection(agentId = agentId, agentName = agentName)
    }
}

/** One channel: mark, "<label> · <platform>", status, the bot's own warning, and the overflow menu. */
@Composable
private fun ChannelRow(channel: ChannelView, onDisconnect: () -> Unit) {
    val c = JunoTheme.colors
    val context = LocalContext.current
    val platform = ChannelPlatform.ofKind(channel.kind)
    val status = channelStatusLine(channel)
    val statusColor = when (status.tone) {
        ChannelTone.Warning -> JunoStatus.warning
        ChannelTone.Success -> JunoStatus.success
        ChannelTone.Muted -> c.fgMuted
    }
    val groupNote = if (channel.status == "active") ChannelLinks.groupNote(channel) else null
    var menu by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 12.dp, bottom = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            platform?.let {
                ChannelMark(it)
                Spacer(Modifier.size(12.dp))
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    listOfNotNull(channelLabel(channel), platform?.title).joinToString(" · "),
                    style = junoText(TextSize.Md, FontWeight.Medium), color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Text(status.text, style = junoText(TextSize.Sm), color = statusColor, maxLines = 2)
                channel.statusMessage?.takeIf { it.isNotEmpty() }?.let {
                    Text(it, style = junoText(TextSize.Sm), color = JunoStatus.warning)
                }
                groupNote?.let { Text(it, style = junoText(TextSize.Sm), color = c.fgSubtle) }
            }
            Box {
                IconButton(onClick = { menu = true }) { Icon(JunoIcons.EllipsisVertical, "Channel options", tint = c.fgMuted) }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    fun act(block: () -> Unit): () -> Unit = { menu = false; block() }
                    if (channel.status == "active") {
                        ChannelLinks.telegramChat(channel)?.let { url ->
                            MenuItem("Open chat", c.fg, act { context.openLink(url) })
                        }
                        ChannelLinks.telegramGroup(channel)?.let { url ->
                            MenuItem("Add to a group", c.fg, act { context.openLink(url) })
                        }
                        ChannelLinks.discordInvite(channel)?.let { url ->
                            MenuItem("Add to a server", c.fg, act { context.openLink(url) })
                        }
                        ChannelLinks.slackCommand(channel)?.let { command ->
                            MenuItem("Copy $command", c.fg, act { context.copyText("Slack command", command) })
                        }
                    }
                    MenuItem("Disconnect", JunoStatus.danger, act(onDisconnect))
                }
            }
        }
        HorizontalDivider(color = c.border)
    }
}

@Composable
private fun MenuItem(label: String, color: Color, onClick: () -> Unit) {
    DropdownMenuItem(text = { Text(label, color = color) }, onClick = onClick)
}

/** A platform's round mark: its initial on a token surface (no brand colours in the token set). */
@Composable
fun ChannelMark(platform: ChannelPlatform, size: Dp = 32.dp) {
    val c = JunoTheme.colors
    Box(
        Modifier.size(size).background(c.muted, CircleShape).border(1.dp, c.border, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(platform.mark, style = junoText(TextSize.Sm, FontWeight.SemiBold), color = c.fg)
    }
}
