package io.github.nigelleong0703.juno.ui.team

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.nav.Route
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.TeamLoad
import io.github.nigelleong0703.juno.state.TeamSegment
import io.github.nigelleong0703.juno.state.agentsData
import io.github.nigelleong0703.juno.state.loadGoals
import io.github.nigelleong0703.juno.state.open
import io.github.nigelleong0703.juno.state.setTeamSegment
import io.github.nigelleong0703.juno.ui.components.AgentAvatar
import io.github.nigelleong0703.juno.ui.components.ButtonSize
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.EmptyLine
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.components.ShowMore
import io.github.nigelleong0703.juno.ui.components.TabHeading
import io.github.nigelleong0703.juno.ui.settings.connectors.SegmentedControl
import io.github.nigelleong0703.juno.ui.theme.AvatarSize
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/**
 * Team, the third tab (owner-approved 2026-10-26, iOS `TeamTab`): Agents · People · Memory. Agents list each agent's role and
 * what it is doing, with its active goals; a tap opens its page, and Goals and New agent sit under the list. People and Memory
 * read the 0.60.0 endpoints: 404 says "Coming soon", 503 says memory is unavailable right now, quietly.
 */
@Composable
fun TeamScreen() {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    LaunchedEffect(Unit) { world.loadGoals() }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        TabHeading("Team")
        SegmentedControl(
            options = listOf(TeamSegment.Agents to "Agents", TeamSegment.People to "People", TeamSegment.Memory to "Memory"),
            selected = state.teamSegment,
            onSelect = { world.setTeamSegment(it) },
        )
        when (state.teamSegment) {
            TeamSegment.Agents -> TeamAgents()
            TeamSegment.People -> TeamPeople()
            TeamSegment.Memory -> TeamMemory()
        }
    }
}

/** Every agent, ten at a time: avatar, name and role, what it is doing (or its last activity), and its active goals. */
@Composable
private fun TeamAgents() {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val data by world.agentsData.collectAsState()
    val c = JunoTheme.colors
    var limit by remember { mutableIntStateOf(10) }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (state.agents.isEmpty()) EmptyLine("No agents yet.")
        state.agents.take(limit).forEach { agent ->
            val goals = data.goals.count { it.agentId == agent.id && it.status == "active" }
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.xl)).background(c.muted.copy(alpha = 0.7f))
                    .clickable { world.open(Route.Agent(agent.id)) }.padding(12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                AgentAvatar(agent, AvatarSize.lg)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            agent.name.orEmpty(), color = c.fg, style = junoText(TextSize.Md, FontWeight.SemiBold),
                            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                        )
                        Text(agent.title.orEmpty(), color = c.fgMuted, style = junoText(TextSize.Sm), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Text((agent.lastActivity ?: agent.status).orEmpty(), color = c.fgMuted, style = junoText(TextSize.Sm), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (goals > 0) Text("$goals active goal${if (goals == 1) "" else "s"}", color = c.fgSubtle, style = junoText(TextSize.Xs))
                }
                Icon(JunoIcons.ChevronRight, null, tint = c.fgSubtle, modifier = Modifier.size(16.dp))
            }
        }
        ShowMore(shown = minOf(limit, state.agents.size), total = state.agents.size, onMore = { limit += 10 })
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.xl)).background(c.muted.copy(alpha = 0.7f)).clickable { world.open(Route.Goals) }.padding(12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(JunoIcons.Target, null, tint = c.fgMuted, modifier = Modifier.size(18.dp))
            Text("Goals", color = c.fg, style = junoText(TextSize.Md, FontWeight.SemiBold), modifier = Modifier.weight(1f))
            Icon(JunoIcons.ChevronRight, null, tint = c.fgSubtle, modifier = Modifier.size(16.dp))
        }
        JunoButton("New agent", { world.open(Route.NewAgent) }, leadingIcon = JunoIcons.Plus, variant = ButtonVariant.Secondary, size = ButtonSize.Large)
    }
}

/** One Team list in its states (iOS `TeamListView`): loading, not shipped yet ("Coming soon"), offline, failed, empty, or the rows. */
@Composable
internal fun <T> TeamListView(load: TeamLoad<T>, emptyText: String, offlineText: String, rows: @Composable (List<T>) -> Unit) {
    val c = JunoTheme.colors
    when (load) {
        TeamLoad.Loading -> CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp, color = c.fgMuted)
        TeamLoad.Unavailable -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("Coming soon", color = c.fg, style = junoText(TextSize.Md, FontWeight.SemiBold))
            Text("People and memory arrive in a coming update.", color = c.fgMuted, style = junoText(TextSize.Sm))
        }
        TeamLoad.Offline -> Text(offlineText, color = c.fgMuted, style = junoText(TextSize.Sm))
        TeamLoad.Failed -> Text("Something went wrong", color = c.fgMuted, style = junoText(TextSize.Sm))
        is TeamLoad.Loaded -> if (load.items.isEmpty()) Text(emptyText, color = c.fgMuted, style = junoText(TextSize.Sm)) else rows(load.items)
    }
}

/** A small text action on a Team row (Link, Unlink, Keep, Forget ...). */
@Composable
internal fun TeamAction(label: String, onClick: () -> Unit) {
    Text(
        label, color = JunoTheme.colors.fg, style = junoText(TextSize.Sm, FontWeight.Medium), maxLines = 1,
        modifier = Modifier.clickable(onClick = onClick).padding(horizontal = 6.dp, vertical = 4.dp),
    )
}
