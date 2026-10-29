package io.github.nigelleong0703.juno.ui.agents

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.ExperimentalFoundationApi
import io.github.nigelleong0703.juno.ui.shell.CircleIcon
import io.github.nigelleong0703.juno.ui.components.AgentAvatar
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
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
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Agent
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.loadAgent
import io.github.nigelleong0703.juno.state.profileLine
import io.github.nigelleong0703.juno.state.setAgentPaused
import io.github.nigelleong0703.juno.state.stopAgent
import io.github.nigelleong0703.juno.ui.components.ButtonSize
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.agents.permissions.PermissionsTab
import io.github.nigelleong0703.juno.ui.theme.AvatarSize
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.launch

/** The six profile pages in order; [id] is what `Route.Agent.tab` carries (iOS `ProfileTab.rawValue`). */
enum class ProfileTab(val id: String, val title: String, val icon: ImageVector) {
    Activity("activity", "Activity", JunoIcons.List),
    Channels("channels", "Channels", JunoIcons.Forum),
    Permissions("approvals", "Permissions", JunoIcons.Shield),
    Computer("computer", "Computer", JunoIcons.Computer),
    Automations("schedules", "Automations", JunoIcons.History),
    Memory("memory", "Memory", JunoIcons.Fingerprint);

    companion object {
        fun of(id: String?): ProfileTab = entries.firstOrNull { it.id == id || it.name.equals(id, ignoreCase = true) } ?: Activity
    }
}

/**
 * An agent's profile as a pushed page (iOS `AgentProfileView`, titled): header, six icon-only tabs, swipeable pages.
 * [tab] picks the first page (a `ProfileTab.id`). Use [AgentCard] for the sheet variant.
 */
@Composable
fun AgentScreen(agentId: String, tab: String? = null, onBack: () -> Unit) {
    AgentProfile(agentId, tab, onClose = onBack, statusBarInset = true)
}

/**
 * The agent profile (iOS `AgentCardView` / `AgentProfileView`): a round close button at the leading end and a round share
 * button at the trailing end (ShareLink "<name> on Juno"), then the header, the six tabs and the swipeable pages. No
 * title bar. [statusBarInset] keeps the top row clear of the status bar for a full-screen page; a sheet does not need it.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun AgentProfile(agentId: String, startTab: String? = null, onClose: () -> Unit, statusBarInset: Boolean = false) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val pager = rememberPagerState(initialPage = ProfileTab.of(startTab).ordinal) { ProfileTab.entries.size }
    val scope = rememberCoroutineScope()
    var editing by remember { mutableStateOf(false) }
    LaunchedEffect(agentId) { world.loadAgent(agentId) }

    Column(
        Modifier.fillMaxSize().background(JunoTheme.colors.canvas).then(if (statusBarInset) Modifier.statusBarsPadding() else Modifier),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        ProfileTopRow(state.agent(agentId)?.name.orEmpty(), onClose)
        ProfileHeader(agentId) { editing = true }
        ProfileTabBar(pager.currentPage) { scope.launch { pager.animateScrollToPage(it) } }
        HorizontalPager(pager, Modifier.weight(1f).fillMaxWidth(), beyondViewportPageCount = 0) { page ->
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, bottom = 32.dp)) {
                when (ProfileTab.entries[page]) {
                    ProfileTab.Activity -> ActivityTab(agentId)
                    ProfileTab.Channels -> ChannelsTab(agentId)
                    ProfileTab.Permissions -> PermissionsTab(agentId)
                    ProfileTab.Computer -> ComputerTab(agentId)
                    ProfileTab.Automations -> AutomationsTab(agentId)
                    ProfileTab.Memory -> MemoryTab(agentId)
                }
            }
        }
    }
    if (editing) AgentEditSheet(agentId) { editing = false }
}

/** iOS `AgentCardView`'s toolbar: a 44 pt round close button (xmark) and a round share button. */
@Composable
private fun ProfileTopRow(name: String, onClose: () -> Unit) {
    val context = LocalContext.current
    Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        CircleIcon(JunoIcons.Close, "Close", onClick = onClose)
        Box(Modifier.weight(1f))
        CircleIcon(JunoIcons.Share, "Share") { context.shareAgent(name) }
    }
}

/** iOS `ShareLink(item: "<name> on Juno")`: the system share sheet with the text. */
private fun Context.shareAgent(name: String) {
    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "$name on Juno")
    startActivity(Intent.createChooser(send, null))
}

/**
 * The six segments of iOS's large segmented picker: one grey capsule, the selected tab a white capsule, 22 dp icons
 * (the Swift uses system symbols at the control's large size).
 */
@Composable
private fun ProfileTabBar(selected: Int, onSelect: (Int) -> Unit) {
    val c = JunoTheme.colors
    Row(Modifier.padding(horizontal = 16.dp).fillMaxWidth().height(48.dp).clip(CircleShape).background(c.muted).padding(3.dp)) {
        ProfileTab.entries.forEachIndexed { i, t ->
            Box(
                Modifier.weight(1f).fillMaxSize().clip(CircleShape).background(if (i == selected) c.card else Color.Transparent).clickable { onSelect(i) },
                contentAlignment = Alignment.Center,
            ) { Icon(t.icon, t.title, tint = if (i == selected) c.fg else c.fgMuted, modifier = Modifier.size(22.dp)) }
        }
    }
}

/** Figure with the pencil, name, and the status line (spec 2.1). */
@Composable
private fun ProfileHeader(agentId: String, onEdit: () -> Unit) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    val agent = state.agent(agentId)
    val (symbol, color) = when (agent?.status) {
        "sleeping" -> JunoIcons.Moon to c.fgMuted
        "error" -> JunoIcons.Alert to JunoStatus.danger
        "needs_you" -> JunoIcons.Alert to JunoStatus.warning
        else -> JunoIcons.Zap to JunoStatus.success
    }
    Column(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Box {
            AgentAvatar(agent, AvatarSize.profile)
            // Flat circle instead of the glass pencil.
            Box(
                Modifier.align(Alignment.BottomEnd).size(28.dp).clip(CircleShape).background(c.card).clickable(onClick = onEdit),
                contentAlignment = Alignment.Center,
            ) { Icon(JunoIcons.Edit, "Edit agent", tint = c.fg, modifier = Modifier.size(14.dp)) }
        }
        Text(agent?.name.orEmpty(), style = junoText(TextSize.Xl, FontWeight.Bold), color = c.fg, modifier = Modifier.padding(top = 6.dp))
        Row(Modifier.padding(horizontal = 24.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            Icon(symbol, null, tint = color, modifier = Modifier.size(18.dp))
            Text(agent?.let { state.profileLine(it) } ?: "", style = junoText(TextSize.Md, FontWeight.Medium), color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
        }
        agent?.let { PauseStopControls(it) }
    }
}

/** Pause / resume and stop (F-09; iOS `AgentProfileView`). The pause button follows `pausedAt`, not `status`. */
@Composable
private fun PauseStopControls(agent: Agent) {
    val world = LocalWorld.current
    val paused = agent.pausedAt != null
    Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        JunoButton(
            text = if (paused) "Resume" else "Pause",
            onClick = { world.setAgentPaused(agent.id, !paused) },
            variant = ButtonVariant.Secondary,
            size = ButtonSize.Sm,
            leadingIcon = if (paused) JunoIcons.Play else JunoIcons.Pause,
            bordered = true,
        )
        JunoButton(
            text = "Stop",
            onClick = { world.stopAgent(agent.id) },
            variant = ButtonVariant.Secondary,
            size = ButtonSize.Sm,
            leadingIcon = JunoIcons.Stop,
            bordered = true,
        )
    }
}
