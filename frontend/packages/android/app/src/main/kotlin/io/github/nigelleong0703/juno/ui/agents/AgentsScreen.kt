package io.github.nigelleong0703.juno.ui.agents

import androidx.compose.foundation.clickable
import io.github.nigelleong0703.juno.ui.components.PageScaffold
import io.github.nigelleong0703.juno.ui.components.EmptyLine
import io.github.nigelleong0703.juno.ui.components.AgentAvatar
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.nav.Route
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.open
import io.github.nigelleong0703.juno.state.profileLine
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.theme.AvatarSize
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** Every agent: avatar, name and what it is doing; a tap opens its page, "New agent" its creation route. */
@Composable
fun AgentsScreen(onBack: (() -> Unit)? = null) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    PageScaffold("Agents", onBack) {
        LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            if (state.agents.isEmpty()) item { EmptyLine("No agents yet.") }
            items(state.agents, key = { it.id }) { agent ->
                Row(Modifier.fillMaxWidth().clickable { world.open(Route.Agent(agent.id)) }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    AgentAvatar(agent, AvatarSize.lg)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(agent.name.orEmpty(), style = junoText(TextSize.Md, FontWeight.SemiBold), color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(state.profileLine(agent), style = junoText(TextSize.Base), color = c.fgMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            item { JunoButton("New agent", { world.open(Route.NewAgent) }, Modifier.fillMaxWidth(), ButtonVariant.Secondary) }
        }
    }
}
