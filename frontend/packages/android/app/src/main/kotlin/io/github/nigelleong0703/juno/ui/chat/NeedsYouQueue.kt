package io.github.nigelleong0703.juno.ui.chat

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.background
import io.github.nigelleong0703.juno.state.Fmt
import io.github.nigelleong0703.juno.ui.components.Hairline
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.nav.Route
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.open
import io.github.nigelleong0703.juno.state.openChat
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** A page bar: back arrow and a title on the flat canvas. */
@Composable
fun ChatPageBar(title: String, onBack: () -> Unit) {
    val c = JunoTheme.colors
    Column(Modifier.fillMaxWidth().background(c.canvas)) {
        Row(Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(JunoIcons.ChevronLeft, "Back", tint = c.fg, modifier = Modifier.size(48.dp).clickable(onClick = onBack).padding(12.dp))
            Text(title, color = c.fg, style = junoText(TextSize.Lg, FontWeight.SemiBold))
        }
        Hairline()
    }
}

/**
 * The Needs-you queue (spec 1.4): every pending request, newest first, with the agent, kind and age. A row opens that
 * request ([onOpenRequest], default `Route.Request`). [agentId] narrows it to one agent's.
 */
@Composable
fun NeedsYouQueueScreen(
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    agentId: String? = null,
    onOpenRequest: ((requestId: String) -> Unit)? = null,
) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    val requests = if (agentId != null) state.pendingOf(agentId) else state.pending
    Column(modifier.fillMaxSize().background(c.canvas)) {
        ChatPageBar("Needs you", onBack)
        if (requests.isEmpty()) Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            Text("Nothing is waiting on you", color = c.fgMuted, style = junoText(TextSize.Md), textAlign = TextAlign.Center)
        } else LazyColumn(Modifier.weight(1f)) {
            items(requests, key = { it.id }) { r ->
                Row(
                    Modifier.fillMaxWidth().clickable { onOpenRequest?.invoke(r.id) ?: world.open(Route.Request(r.id)) }.padding(horizontal = 16.dp, vertical = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(requestIcon(r), null, tint = JunoStatus.warning)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(ChatFormat.sentence(r), color = c.fg, style = junoText(TextSize.Md, FontWeight.Medium), maxLines = 2)
                        Text(
                            listOfNotNull(state.agent(r.agentId)?.name, Fmt.requestTitle(r.kind), ChatFormat.ago(r.createdAt).ifEmpty { null }).joinToString(" · "),
                            color = c.fgMuted, style = junoText(TextSize.Sm), maxLines = 1,
                        )
                    }
                    Icon(JunoIcons.ChevronRight, null, tint = c.fgSubtle, modifier = Modifier.size(16.dp))
                }
                Box(Modifier.padding(start = 52.dp).fillMaxWidth().height(0.5.dp).background(c.border))
            }
        }
    }
}

/** One request in full: its card (Deny / Allow and the rest), and "Open in chat" when it belongs to one. */
@Composable
fun RequestDetailScreen(requestId: String, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    val request = state.request(requestId)
    Column(modifier.fillMaxSize().background(c.canvas)) {
        ChatPageBar(Fmt.requestTitle(request?.kind), onBack)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (request == null) Text("This request is no longer available.", color = c.fgMuted, style = junoText(TextSize.Base))
            else RequestCard(request, state.agent(request.agentId)?.name, state.isQuiet(request))
            request?.conversationId?.let { chat -> JunoButton("Open in chat", { world.openChat(chat) }, variant = ButtonVariant.Ghost) }
        }
    }
}
