package io.github.nigelleong0703.juno.ui.goals

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.clickable
import io.github.nigelleong0703.juno.ui.components.PageScaffold
import io.github.nigelleong0703.juno.ui.components.EmptyLine
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.GoalActivity
import io.github.nigelleong0703.juno.contract.GoalMilestone
import io.github.nigelleong0703.juno.nav.Route
import io.github.nigelleong0703.juno.state.Fmt
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.agentsData
import io.github.nigelleong0703.juno.state.checkGoal
import io.github.nigelleong0703.juno.state.loadGoal
import io.github.nigelleong0703.juno.state.open
import io.github.nigelleong0703.juno.state.setGoalStatus
import io.github.nigelleong0703.juno.ui.agents.SectionCard
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** Goal detail (spec 2.21): facts, Check now / Pause / Resume, the plan and the activity timeline. Fetched on appear. */
@Composable
fun GoalScreen(id: String, onBack: () -> Unit) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val data by world.agentsData.collectAsState()
    val c = JunoTheme.colors
    val goal = data.goal(id)
    var milestoneLimit by remember { mutableIntStateOf(8) }
    var activityLimit by remember { mutableIntStateOf(10) }
    // "Check now" stays disabled after one tap until Pause or Resume (spec 5.23): local only.
    var checkRequested by remember { mutableStateOf(false) }
    LaunchedEffect(id) { world.loadGoal(id) }
    val allActivity = goal?.activity.orEmpty()
    val activity = allActivity.filter { !(it.kind == "quote" && it.milestoneId != null) }
    val milestones = goal?.milestones.orEmpty()
    val active = goal?.status == "active"
    val agentName = state.agent(goal?.agentId)?.name ?: "Agent"

    PageScaffold(goal?.title ?: "Goal", onBack) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            SectionCard {
                Fact("Kind", if (goal?.kind == "tracking") "Tracking" else "Goal")
                Fact("Category", goal?.category?.let(Fmt::capitalized))
                Fact("Agent", state.agent(goal?.agentId)?.name)
                Fact("Status", goal?.status?.let(Fmt::capitalized))
                goal?.summary?.takeIf { it.isNotEmpty() }?.let { Text(it, style = junoText(TextSize.Base), color = c.fg, modifier = Modifier.padding(vertical = 12.dp)) }
            }
            if (goal?.status == "active" || goal?.status == "paused") {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (active) JunoButton(if (checkRequested) "Check-in requested" else "Check now", { checkRequested = true; world.checkGoal(id) }, Modifier.fillMaxWidth(), ButtonVariant.Secondary, enabled = !checkRequested)
                    JunoButton(if (active) "Pause" else "Resume", { world.setGoalStatus(id, if (active) "paused" else "active"); checkRequested = false }, Modifier.fillMaxWidth(), ButtonVariant.Secondary)
                    if (active && goal?.nextCheckAt != null) {
                        Text("Next check-in ${Fmt.ago(goal.nextCheckAt)}" + (goal.lastCheckedAt?.let { ", last checked ${Fmt.ago(it)}" } ?: ""), style = junoText(TextSize.Sm), color = c.fgMuted)
                    }
                }
            }
            Text("Plan", style = junoText(TextSize.Lg, FontWeight.SemiBold), color = c.fg)
            if (milestones.isEmpty()) EmptyLine(if (active) "Your agent is writing the plan." else "No plan yet.")
            milestones.take(milestoneLimit).forEach { m -> MilestoneRow(m, allActivity.filter { it.kind == "quote" && it.milestoneId == m.id }.mapNotNull { it.text }) }
            if (milestones.size > milestoneLimit) MoreLink("Show more (${milestones.size - milestoneLimit})") { milestoneLimit += 8 }

            Text("Activity", style = junoText(TextSize.Lg, FontWeight.SemiBold), color = c.fg)
            if (activity.isEmpty()) EmptyLine("Nothing recorded yet.")
            activity.take(activityLimit).forEach { ActivityRow(it, agentName) }
            if (activity.size > activityLimit) MoreLink("Show more (${activity.size - activityLimit})") { activityLimit += 10 }
        }
    }
}

@Composable
private fun Fact(key: String, value: String?) {
    if (value.isNullOrEmpty()) return
    val c = JunoTheme.colors
    Row(Modifier.fillMaxWidth().padding(vertical = 12.dp)) {
        Text(key, style = junoText(TextSize.Base), color = c.fg, modifier = Modifier.weight(1f))
        Text(value, style = junoText(TextSize.Base), color = c.fgMuted)
    }
}

@Composable
private fun MoreLink(text: String, onClick: () -> Unit) =
    Text(text, style = junoText(TextSize.Base, FontWeight.Medium), color = JunoTheme.colors.fgMuted, modifier = Modifier.clickable(onClick = onClick).padding(vertical = 6.dp))

/** One milestone: status glyph, title, due date; its quotes sit under a disclosure (spec 2.21, 5.24). */
@Composable
private fun MilestoneRow(m: GoalMilestone, quotes: List<String>) {
    val c = JunoTheme.colors
    var open by remember { mutableStateOf(false) }
    val (icon, tint) = when (m.status) {
        "done" -> JunoIcons.CheckCircle to c.fgMuted
        "doing" -> JunoIcons.Contrast to c.fg
        "blocked" -> JunoIcons.Alert to c.fg
        else -> JunoIcons.Circle to c.fgSubtle
    }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Icon(icon as ImageVector, null, tint = tint as Color, modifier = Modifier.padding(top = 2.dp).size(20.dp))
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(m.title.orEmpty(), style = junoText(TextSize.Base), color = if (m.status == "done") c.fgMuted else c.fg, textDecoration = if (m.status == "done") TextDecoration.LineThrough else null)
            val state = if (m.status == "blocked") "Blocked" else if (m.status == "doing") "In progress" else null
            val line = listOfNotNull(state, m.due?.let { "Due ${Fmt.date(it)}" }).joinToString(" · ")
            if (line.isNotEmpty()) Text(line, style = junoText(TextSize.Xs), color = c.fgSubtle)
            if (quotes.isNotEmpty()) {
                Text(if (quotes.size == 1) "1 quote" else "${quotes.size} quotes", style = junoText(TextSize.Xs), color = c.fgSubtle, modifier = Modifier.clickable { open = !open })
                if (open) quotes.forEach { Text(it, style = junoText(TextSize.Xs), color = c.fgMuted) }
            }
        }
    }
}

@Composable
private fun ActivityRow(entry: GoalActivity, agentName: String) {
    val world = LocalWorld.current
    val c = JunoTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(entry.text.orEmpty(), style = junoText(TextSize.Base), color = c.fg)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(listOf(if (entry.actor == "agent") agentName else "You", Fmt.ago(entry.at)).filter { it.isNotEmpty() }.joinToString(" · "), style = junoText(TextSize.Xs), color = c.fgMuted)
            entry.runId?.let { run -> Text("· Task", style = junoText(TextSize.Xs, FontWeight.Medium), color = c.fg, modifier = Modifier.clickable { world.open(Route.Run(run)) }) }
        }
    }
}
