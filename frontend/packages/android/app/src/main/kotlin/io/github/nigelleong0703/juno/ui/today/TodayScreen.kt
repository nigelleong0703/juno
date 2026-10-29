package io.github.nigelleong0703.juno.ui.today

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Goal
import io.github.nigelleong0703.juno.contract.Request
import io.github.nigelleong0703.juno.nav.Route
import io.github.nigelleong0703.juno.state.FeedItem
import io.github.nigelleong0703.juno.state.Fmt
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.WorldState
import io.github.nigelleong0703.juno.state.acceptIdea
import io.github.nigelleong0703.juno.state.agentsData
import io.github.nigelleong0703.juno.state.ideaFeedback
import io.github.nigelleong0703.juno.state.loadGoals
import io.github.nigelleong0703.juno.state.markRunSeen
import io.github.nigelleong0703.juno.state.open
import io.github.nigelleong0703.juno.state.openChat
import io.github.nigelleong0703.juno.state.openFeedPost
import io.github.nigelleong0703.juno.state.scheduleTodayRefresh
import io.github.nigelleong0703.juno.ui.chat.ChatFormat
import io.github.nigelleong0703.juno.ui.chat.RequestCard
import io.github.nigelleong0703.juno.ui.chat.TodaySummary
import io.github.nigelleong0703.juno.ui.components.AgentAvatar
import io.github.nigelleong0703.juno.ui.components.ButtonSize
import io.github.nigelleong0703.juno.ui.components.Hairline
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** Rows per block before "All" (owner-approved 2026-10-26: capped everywhere). */
private const val LIMIT = 3

/** One row of Progress: a run that is working, or one that has just finished. */
private data class ProgressRow(val agentId: String, val runId: String, val title: String, val done: Boolean)

/**
 * Today, the first tab (owner-approved 2026-10-26, iOS `TodayTab`): a greeting with the owner's avatar top left (it opens
 * Me), then four blocks, each capped at three rows with "All" for the rest. Needs you: every pending request with its own
 * actions and "Open chat" (requests only, as on iOS; memory to review and possible matches live in Team). Progress: what
 * the agents did and are doing, plus the goals card. Updates: the brief and the newest Feed posts ("All" opens the Feed).
 * Ideas: the open ideas, Try or Never ("All" opens the Ideas page). A block with nothing to say is not shown.
 */
@Composable
fun TodayScreen() {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val data by world.agentsData.collectAsState()
    val today = TodaySummary.build(state, state.today)
    var needsAll by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { world.loadGoals() }
    // Today follows requests and runs; a burst of events refetches once.
    LaunchedEffect(state.requests, state.runs) { world.scheduleTodayRefresh() }

    val name = world.session.value?.name.orEmpty()
    val first = name.split(' ').firstOrNull().orEmpty()
    val greeting = if (state.agents.isEmpty()) {
        if (first.isEmpty()) "Welcome" else "Welcome, $first"
    } else {
        ChatFormat.greeting(today.hour ?: java.time.LocalTime.now().hour, first)
    }
    // The one line under the greeting: what needs the owner, else who is working, else quiet (iOS statusLine).
    val status = when {
        today.needsYouCount == 1 -> "1 thing needs you"
        today.needsYouCount > 1 -> "${today.needsYouCount} things need you"
        today.working.isNotEmpty() -> "${today.working.size} working"
        else -> "All quiet"
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp),
    ) {
        TodayHeader(greeting, status)
        if (state.agents.isEmpty()) FirstAgentCard()
        NeedsYouBlock(state.needsYou, state, needsAll) { needsAll = !needsAll }
        ProgressBlock(today, data.goals, state)
        UpdatesBlock(today.brief, state)
        IdeasBlock(state)
    }
}

@Composable
private fun TodayHeader(greeting: String, status: String) {
    val world = LocalWorld.current
    val c = JunoTheme.colors
    Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(
            JunoIcons.Profile, contentDescription = "Me", tint = c.fgMuted,
            modifier = Modifier.size(36.dp).clip(CircleShape).clickable(role = Role.Button) { world.open(Route.YourDetails) },
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(greeting, color = c.fg, style = junoText(TextSize.Xxl, FontWeight.Bold), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(status, color = c.fgMuted, style = junoText(TextSize.Md))
        }
    }
}

/** No agent yet: the one thing to do, and the button under it. */
@Composable
private fun FirstAgentCard() {
    val world = LocalWorld.current
    val c = JunoTheme.colors
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.xl)).background(c.muted.copy(alpha = 0.7f)).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Meet your first agent", color = c.fg, style = junoText(TextSize.Md, FontWeight.Medium))
        Text("Works for you in the background and tells you what it found", color = c.fgMuted, style = junoText(TextSize.Sm))
        JunoButton("Create your first agent", { world.open(Route.NewAgent) }, Modifier.fillMaxWidth(), size = ButtonSize.Large)
    }
}

/** A titled block; [allLabel] with [onAll] is the link at its trailing end ("All", or "Show fewer" when expanded). */
@Composable
private fun TodaySection(title: String, allLabel: String? = null, onAll: (() -> Unit)? = null, content: @Composable () -> Unit) {
    val c = JunoTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(title, color = c.fgMuted, style = junoText(TextSize.Sm, FontWeight.SemiBold), modifier = Modifier.weight(1f))
            if (allLabel != null && onAll != null) {
                Text(allLabel, color = c.fg, style = junoText(TextSize.Sm, FontWeight.Medium), modifier = Modifier.clickable(onClick = onAll).padding(horizontal = 4.dp, vertical = 2.dp))
            }
        }
        content()
    }
}

/** The pending requests, each with its own card and "Open chat"; memory to review and possible matches are in Team. */
@Composable
private fun NeedsYouBlock(requests: List<Request>, state: WorldState, expanded: Boolean, onToggle: () -> Unit) {
    if (requests.isEmpty()) return
    val shown = if (expanded) requests else requests.take(LIMIT)
    TodaySection(
        title = "Needs you",
        allLabel = if (requests.size > LIMIT) (if (expanded) "Show fewer" else "All · ${requests.size}") else null,
        onAll = onToggle,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            shown.forEach { request -> AskRow(request, state) }
        }
    }
}

@Composable
private fun AskRow(request: Request, state: WorldState) {
    val world = LocalWorld.current
    val c = JunoTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        RequestCard(request, agentName = state.agent(request.agentId)?.name, quiet = false, compact = true)
        request.conversationId?.let { conversationId ->
            Text(
                "Open chat", color = c.fg, style = junoText(TextSize.Sm, FontWeight.Medium), textAlign = TextAlign.End,
                modifier = Modifier.fillMaxWidth().clickable { world.openChat(conversationId) }.padding(horizontal = 4.dp, vertical = 2.dp),
            )
        }
    }
}

/** What agents are doing and finished (three rows at most, working first), then the goals card that opens the goals list. */
@Composable
private fun ProgressBlock(today: TodaySummary, goals: List<Goal>, state: WorldState) {
    val c = JunoTheme.colors
    val rows = (
        today.working.map { ProgressRow(it.agentId, it.runId, it.title, done = false) } +
            today.completed.map { ProgressRow(it.agentId, it.runId, it.title, done = true) }
        ).take(LIMIT)
    if (rows.isEmpty() && goals.isEmpty()) return
    TodaySection(title = "Progress") {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (rows.isNotEmpty()) {
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.xl)).background(c.muted.copy(alpha = 0.7f))) {
                    rows.forEachIndexed { i, row ->
                        if (i > 0) Hairline(Modifier.padding(start = 48.dp))
                        ProgressLine(row, state)
                    }
                }
            }
            if (goals.isNotEmpty()) GoalsCard(goals)
        }
    }
}

@Composable
private fun ProgressLine(row: ProgressRow, state: WorldState) {
    val world = LocalWorld.current
    val c = JunoTheme.colors
    Row(
        Modifier.fillMaxWidth().clickable {
            if (row.done) world.markRunSeen(row.runId)
            world.open(Route.Agent(row.agentId))
        }.padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        AgentAvatar(state.agent(row.agentId), 32.dp)
        Text(row.title, color = c.fg, style = junoText(TextSize.Base), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (row.done) Icon(JunoIcons.CheckCircle, null, tint = JunoStatus.success, modifier = Modifier.size(20.dp))
        else CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = c.fgMuted)
    }
}

/** The goals card: how many are active and done; a tap opens the goals list. */
@Composable
private fun GoalsCard(goals: List<Goal>) {
    val world = LocalWorld.current
    val c = JunoTheme.colors
    val active = goals.count { it.status == "active" }
    val done = goals.count { it.status == "done" }
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.xl)).background(c.muted.copy(alpha = 0.7f)).clickable { world.open(Route.Goals) }
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(JunoIcons.Target, null, tint = c.fgMuted, modifier = Modifier.size(18.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("Goals", color = c.fgMuted, style = junoText(TextSize.Sm, FontWeight.SemiBold))
            Text("$active active · $done done", color = c.fg, style = junoText(TextSize.Md))
        }
        Icon(JunoIcons.ChevronRight, null, tint = c.fgSubtle, modifier = Modifier.size(16.dp))
    }
}

/** The brief first, then the newest Feed posts; "All" opens the full Feed. */
@Composable
private fun UpdatesBlock(brief: TodaySummary.Brief?, state: WorldState) {
    val world = LocalWorld.current
    val c = JunoTheme.colors
    val posts = state.feed.filter { it.post.feedback != "less" }.take(LIMIT)
    if (brief == null && posts.isEmpty()) return
    TodaySection(title = "Updates", allLabel = "All", onAll = { world.open(Route.Feed) }) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (brief != null) {
                Text(
                    brief.summary, color = c.fg, style = junoText(TextSize.Md, FontWeight.Medium), maxLines = 2, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.xl)).background(c.muted.copy(alpha = 0.7f)).clickable { world.open(Route.Feed) }.padding(12.dp),
                )
            }
            posts.forEach { item -> PostRow(item, state) }
        }
    }
}

@Composable
private fun PostRow(item: FeedItem, state: WorldState) {
    val world = LocalWorld.current
    val c = JunoTheme.colors
    val post = item.post
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.xl)).background(c.muted.copy(alpha = 0.7f)).clickable { world.openFeedPost(post.id) }
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        AgentAvatar(state.agent(post.agentId), 32.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(post.title.orEmpty(), color = c.fg, style = junoText(TextSize.Base, FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
            post.summary?.takeIf { it.isNotEmpty() }?.let { Text(it, color = c.fgMuted, style = junoText(TextSize.Sm), maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
        Text(Fmt.time(post.createdAt), color = c.fgSubtle, style = junoText(TextSize.Xs))
    }
}

/** The open ideas, three at most: Try starts the agent on it in a new chat, Never stops it being offered again. */
@Composable
private fun IdeasBlock(state: WorldState) {
    val world = LocalWorld.current
    val c = JunoTheme.colors
    val ideas = state.ideas.take(LIMIT)
    if (ideas.isEmpty()) return
    TodaySection(title = "Ideas", allLabel = "All", onAll = { world.open(Route.Ideas) }) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            ideas.forEach { idea ->
                Column(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.xl)).background(c.muted.copy(alpha = 0.7f)).padding(14.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(idea.text ?: idea.prompt.orEmpty(), color = c.fg, style = junoText(TextSize.Md, FontWeight.Medium))
                    idea.why?.takeIf { it.isNotEmpty() }?.let { Text(it, color = c.fgMuted, style = junoText(TextSize.Sm)) }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            "Never", color = c.fgMuted, style = junoText(TextSize.Sm, FontWeight.Medium),
                            modifier = Modifier.clickable { world.ideaFeedback(idea.id, "never", "topic") }.padding(horizontal = 10.dp, vertical = 6.dp),
                        )
                        Spacer(Modifier.width(8.dp))
                        Box(Modifier.clip(CircleShape).background(c.primary).clickable { world.acceptIdea(idea) }.padding(horizontal = 14.dp, vertical = 6.dp)) {
                            Text("Try", color = c.primaryFg, style = junoText(TextSize.Sm, FontWeight.SemiBold))
                        }
                    }
                }
            }
        }
    }
}
