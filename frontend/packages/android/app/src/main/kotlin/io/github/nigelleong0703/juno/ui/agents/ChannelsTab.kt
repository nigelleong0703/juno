package io.github.nigelleong0703.juno.ui.agents

import androidx.compose.foundation.layout.Arrangement
import io.github.nigelleong0703.juno.ui.components.EmptyLine
import io.github.nigelleong0703.juno.ui.components.ShowMore
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.material3.Text
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.state.ChannelView
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.agentsData
import io.github.nigelleong0703.juno.state.loadChannels
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

private fun label(c: ChannelView): String =
    c.handle?.takeIf { it.isNotEmpty() }?.let { "@$it" } ?: c.displayName ?: c.botUsername?.let { "@$it" } ?: "Channel"

private fun statusOf(c: ChannelView): Pair<String, androidx.compose.ui.graphics.Color?> = when (c.status) {
    "invalid_token", "expired", "error" -> "Needs reconnecting" to JunoStatus.warning
    "pending_install" -> "Waiting for install" to JunoStatus.warning
    else -> if (c.bound == true) "Linked to you" to JunoStatus.success else "Waiting for your first message" to null
}

/**
 * Where to find this agent: its connected messaging channels, first 3 then "Show more". Read-only here: connecting and
 * disconnecting belong to the Channels feature (route `Route.Channels`), which is not part of this port.
 */
@Composable
fun ChannelsTab(agentId: String) {
    val world = LocalWorld.current
    val data by world.agentsData.collectAsState()
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    var showAll by remember { mutableStateOf(false) }
    LaunchedEffect(agentId) { world.loadChannels(agentId) }
    val list = data.channels[agentId]
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        TabHeader("Where to find ${state.agent(agentId)?.name ?: "this agent"}")
        if (list != null && list.isEmpty()) EmptyLine("Not on any messaging app yet.")
        val shown = if (showAll) list.orEmpty() else list.orEmpty().take(3)
        shown.forEach { ch ->
            val (text, color) = statusOf(ch)
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(listOfNotNull(label(ch), ch.kind.replaceFirstChar { it.uppercase() }).joinToString(" · "), style = junoText(TextSize.Base, FontWeight.Medium), color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(text, style = junoText(TextSize.Sm), color = color ?: c.fgMuted)
                ch.statusMessage?.takeIf { it.isNotEmpty() }?.let { Text(it, style = junoText(TextSize.Sm), color = JunoStatus.warning) }
            }
        }
        ShowMore(shown.size, list?.size ?: 0, { showAll = true })
    }
}
