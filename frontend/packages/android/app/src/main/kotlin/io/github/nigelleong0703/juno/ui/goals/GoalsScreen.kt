package io.github.nigelleong0703.juno.ui.goals

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.ExperimentalFoundationApi
import io.github.nigelleong0703.juno.ui.components.Hairline
import io.github.nigelleong0703.juno.ui.components.ShowMore
import io.github.nigelleong0703.juno.ui.components.AgentAvatar
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.clickable
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Goal
import io.github.nigelleong0703.juno.core.parseIso
import io.github.nigelleong0703.juno.nav.Route
import io.github.nigelleong0703.juno.state.Fmt
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.agentsData
import io.github.nigelleong0703.juno.state.loadGoals
import io.github.nigelleong0703.juno.state.loadRoutines
import io.github.nigelleong0703.juno.state.open
import io.github.nigelleong0703.juno.state.openChat
import io.github.nigelleong0703.juno.ui.components.ButtonSize
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.EmptyState
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.theme.AvatarSize
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import java.time.Instant
import java.time.ZoneId

/** Routines due before tomorrow 00:00 local, past-due included, by time (spec 2.19 "Later today"). */
fun laterToday(routines: List<io.github.nigelleong0703.juno.contract.Routine>, scope: String?, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): List<io.github.nigelleong0703.juno.contract.Routine> {
    val end = now.atZone(zone).toLocalDate().plusDays(1).atStartOfDay(zone).toInstant()
    return routines.filter { it.enabled == true && (parseIso(it.nextRunAt) ?: Instant.MAX) < end && (scope == null || it.agentId == scope) }
        .sortedBy { parseIso(it.nextRunAt) ?: Instant.MAX }
}

/**
 * The Goals page (spec 2.19), pushed from Team and Today: Tracking, Goals and Later today, 8 rows each. Scoped to the agent
 * filter. The checkboxes are local only: not sent to the server and lost on relaunch (spec 5.2).
 */
@Composable
fun GoalsScreen() {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val data by world.agentsData.collectAsState()
    val c = JunoTheme.colors
    var creating by remember { mutableStateOf(false) }
    var done by remember { mutableStateOf(setOf<String>()) }
    var tracking by remember(state.scope) { mutableIntStateOf(8) }
    var goalsLimit by remember(state.scope) { mutableIntStateOf(8) }
    var laterLimit by remember(state.scope) { mutableIntStateOf(8) }
    LaunchedEffect(Unit) { world.loadGoals(); world.loadRoutines() }
    val goals = data.goals.filter { state.scope == null || it.agentId == state.scope }
    val later = laterToday(data.routines, state.scope)

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Column(Modifier.widthIn(max = 640.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(24.dp)) {
            Row(Modifier.padding(top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Spacer(Modifier.weight(1f))
                JunoButton(
                    "Create goal", { creating = true }, variant = ButtonVariant.Secondary, size = ButtonSize.Large,
                    enabled = state.agents.isNotEmpty(), leadingIcon = JunoIcons.Plus, bordered = true,
                )
            }
            if (goals.isEmpty() && later.isEmpty() && data.goalsLoaded) {
                EmptyState(JunoIcons.CheckSquare, "No goals yet", "Create one, or ask an agent to track something for you.", Modifier.padding(vertical = 12.dp))
            }
            GoalGroup("Tracking", goals.filter { it.kind == "tracking" }, tracking, done, { id -> done = if (id in done) done - id else done + id }) { tracking += 8 }
            GoalGroup("Goals", goals.filter { it.kind == "goal" }, goalsLimit, done, { id -> done = if (id in done) done - id else done + id }) { goalsLimit += 8 }
            if (later.isNotEmpty()) {
                Column {
                    Text("Later today", style = junoText(TextSize.Lg, FontWeight.SemiBold), color = c.fg, modifier = Modifier.padding(bottom = 4.dp))
                    later.take(laterLimit).forEachIndexed { i, routine ->
                        Row(Modifier.defaultMinSize(minHeight = 48.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            AgentAvatar(state.agent(routine.agentId), AvatarSize.md)
                            Text(routine.name.orEmpty(), style = junoText(TextSize.Base), color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                            Text(Fmt.time(routine.nextRunAt), style = junoText(TextSize.Sm), color = c.fgMuted)
                        }
                        if (i < minOf(laterLimit, later.size) - 1) Hairline()
                    }
                    ShowMore(minOf(laterLimit, later.size), later.size, { laterLimit += 8 })
                }
            }
        }
    }
    if (creating) CreateGoalSheet { creating = false }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun GoalGroup(title: String, goals: List<Goal>, limit: Int, done: Set<String>, onToggle: (String) -> Unit, onMore: () -> Unit) {
    if (goals.isEmpty()) return
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    Column {
        Text(title, style = junoText(TextSize.Lg, FontWeight.SemiBold), color = c.fg, modifier = Modifier.padding(bottom = 4.dp))
        goals.take(limit).forEachIndexed { i, goal ->
            var menu by remember { mutableStateOf(false) }
            val checked = goal.id in done
            val chat = state.directConversation(goal.agentId.orEmpty())
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(width = 44.dp, height = 48.dp).clickable { onToggle(goal.id) }, contentAlignment = Alignment.Center) {
                    Icon(if (checked) JunoIcons.CheckSquare else JunoIcons.Square, if (checked) "Mark incomplete" else "Mark complete", tint = c.fgMuted, modifier = Modifier.size(22.dp))
                }
                Box(Modifier.weight(1f)) {
                    Column(
                        Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp).combinedClickable(onClick = { world.open(Route.Goal(goal.id)) }, onLongClick = { menu = true }).padding(vertical = 4.dp),
                        verticalArrangement = Arrangement.spacedBy(3.dp),
                    ) {
                        Text(goal.title.orEmpty(), style = junoText(TextSize.Base, FontWeight.Medium), color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, textDecoration = if (checked) TextDecoration.LineThrough else null)
                        goal.summary?.takeIf { it.isNotEmpty() }?.let { Text(it, style = junoText(TextSize.Sm), color = c.fgMuted, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                        goal.milestones?.takeIf { it.isNotEmpty() }?.let { plan ->
                            val doing = plan.count { it.status == "doing" }
                            Text("${plan.count { it.status == "done" }}/${plan.size} milestones" + if (doing > 0) " · $doing in progress" else "", style = junoText(TextSize.Xs), color = c.fgSubtle)
                        }
                        goal.category?.takeIf { it.isNotEmpty() }?.let { Text(Fmt.capitalized(it), style = junoText(TextSize.Xs), color = c.fgSubtle) }
                    }
                    DropdownMenu(menu, { menu = false }, containerColor = c.card) {
                        DropdownMenuItem(
                            text = { Text("Discuss in chat") }, enabled = chat != null,
                            onClick = { menu = false; world.openChat(chat?.id, draft = "About “${goal.title.orEmpty()}”: ") },
                        )
                    }
                }
            }
            if (i < minOf(limit, goals.size) - 1) Hairline()
        }
        ShowMore(minOf(limit, goals.size), goals.size, onMore)
    }
}
