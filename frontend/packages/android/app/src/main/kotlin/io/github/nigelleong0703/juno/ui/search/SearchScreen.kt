package io.github.nigelleong0703.juno.ui.search

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Agent
import io.github.nigelleong0703.juno.contract.Conversation
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.openAgent
import io.github.nigelleong0703.juno.state.openChat
import io.github.nigelleong0703.juno.ui.components.AgentAvatar
import io.github.nigelleong0703.juno.ui.components.rememberCloseAction
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

private const val SECTION_LIMIT = 5

/**
 * Full-screen search (iOS `SearchPage`): recent chats while the field is empty; matching agents and chats once it is
 * not. A result closes the search first, then opens the agent or chat.
 */
@Composable
fun SearchScreen() {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    val close = rememberCloseAction()
    val focus = remember { FocusRequester() }
    var query by remember { mutableStateOf("") }
    var expanded by remember { mutableStateOf(emptySet<String>()) }
    LaunchedEffect(Unit) { focus.requestFocus() }

    val q = query.trim()
    val agents = if (q.isEmpty()) emptyList() else state.agents.filter { (it.name ?: "").contains(q, ignoreCase = true) }
    val chats = if (q.isEmpty()) emptyList() else state.sortedConversations.filter { state.title(it).contains(q, ignoreCase = true) }

    fun openAgentResult(agent: Agent) {
        close()
        world.openAgent(agent.id)
    }

    fun openChatResult(chat: Conversation) {
        close()
        world.openChat(chat.id)
    }

    Column(Modifier.fillMaxSize().background(c.canvas).padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(
                Modifier.weight(1f).height(44.dp).clip(CircleShape).background(c.muted).padding(horizontal = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(JunoIcons.Search, contentDescription = null, tint = c.fgSubtle)
                BasicTextField(
                    value = query,
                    onValueChange = { query = it },
                    singleLine = true,
                    textStyle = junoText(TextSize.Lg).copy(color = c.fg),
                    cursorBrush = SolidColor(c.fg),
                    modifier = Modifier.weight(1f).focusRequester(focus),
                    decorationBox = { inner ->
                        if (query.isEmpty()) Text("Search", style = junoText(TextSize.Lg), color = c.fgSubtle)
                        inner()
                    },
                )
            }
            TextButton(onClick = close) { Text("Cancel", style = junoText(TextSize.Md, FontWeight.Medium), color = c.fg) }
        }

        LazyColumn(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            if (q.isEmpty()) {
                section("Recents", "recents", state.recentConversations, expanded, c.fgMuted, { expanded = expanded + "recents" }) { chat ->
                    ResultRow(JunoIcons.Chat, title = state.title(chat)) { openChatResult(chat) }
                }
            } else if (agents.isEmpty() && chats.isEmpty()) {
                item { Text("No results", style = junoText(TextSize.Lg), color = c.fgMuted, modifier = Modifier.padding(top = 22.dp)) }
            } else {
                section("Agents", "agents", agents, expanded, c.fgMuted, { expanded = expanded + "agents" }) { agent ->
                    ResultRow(agent = agent, title = agent.name.orEmpty()) { openAgentResult(agent) }
                }
                section("Chats", "chats", chats, expanded, c.fgMuted, { expanded = expanded + "chats" }) { chat ->
                    ResultRow(JunoIcons.Chat, title = state.title(chat)) { openChatResult(chat) }
                }
            }
        }
    }
}

/** A labelled group of results, five at a time, with "Show all" when there are more. */
private fun <T> androidx.compose.foundation.lazy.LazyListScope.section(
    title: String,
    id: String,
    items: List<T>,
    expanded: Set<String>,
    muted: Color,
    onShowAll: () -> Unit,
    row: @Composable (T) -> Unit,
) {
    if (items.isEmpty()) return
    val all = id in expanded
    item(key = "header-$id") {
        Text(title, style = junoText(TextSize.Sm, FontWeight.SemiBold), color = muted, modifier = Modifier.padding(top = 12.dp, bottom = 4.dp, start = 4.dp))
    }
    val shown = if (all) items else items.take(SECTION_LIMIT)
    shown.forEachIndexed { index, item -> item(key = "$id-$index") { row(item) } }
    if (!all && items.size > SECTION_LIMIT) {
        item(key = "more-$id") {
            Row(Modifier.fillMaxWidth().clickable(onClick = onShowAll).padding(vertical = 10.dp, horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(JunoIcons.ChevronDown, contentDescription = null, tint = muted)
                Spacer(Modifier.width(8.dp))
                Text("Show all", style = junoText(TextSize.Base, FontWeight.Medium), color = muted)
            }
        }
    }
}

@Composable
private fun ResultRow(icon: ImageVector? = null, agent: Agent? = null, title: String, onClick: () -> Unit) {
    val c = JunoTheme.colors
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 4.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (agent != null) AgentAvatar(agent, size = 22.dp, animated = false, tile = true)
        else icon?.let { Icon(it, contentDescription = null, tint = c.fgMuted, modifier = Modifier.size(20.dp)) }
        Text(title, style = junoText(TextSize.Lg), color = c.fg, maxLines = 1)
    }
}
