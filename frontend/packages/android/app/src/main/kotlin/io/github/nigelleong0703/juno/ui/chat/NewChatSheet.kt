package io.github.nigelleong0703.juno.ui.chat

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Agent
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.createConversation
import io.github.nigelleong0703.juno.state.doingLine
import io.github.nigelleong0703.juno.ui.components.AgentAvatar
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.GroupedRow
import io.github.nigelleong0703.juno.ui.components.GroupedSearchField
import io.github.nigelleong0703.juno.ui.components.GroupedSection
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.components.JunoTextField
import io.github.nigelleong0703.juno.ui.components.PageHeader
import io.github.nigelleong0703.juno.ui.components.PageLeading
import io.github.nigelleong0703.juno.ui.components.RowMarker
import io.github.nigelleong0703.juno.ui.settings.SettingsEmpty
import io.github.nigelleong0703.juno.ui.settings.SettingsError
import io.github.nigelleong0703.juno.ui.theme.AvatarSize
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.SystemText
import kotlinx.coroutines.launch
import java.util.UUID

private sealed interface Step { data object List : Step; data object Members : Step; data object Review : Step }

/**
 * The new-chat sheet (iOS New chat): a "Cancel" capsule and the centred title; a grouped section with "New group" and
 * "New agent", an "Agents" section, and the search field at the foot. Pick an agent for a direct chat (created or reused),
 * "New group" (pick 2-6, then name it and create), or "New agent". A chat is created idempotently: the same [UUID]
 * request id is reused for a retry. [onOpenChat] gets the conversation id to open; [onNewAgent] opens the new-agent flow.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewChatSheet(onDismiss: () -> Unit, onOpenChat: (conversationId: String) -> Unit, onNewAgent: () -> Unit = { }) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    val scope = rememberCoroutineScope()
    var step by remember { mutableStateOf<Step>(Step.List) }
    var query by remember { mutableStateOf("") }
    var busyAgent by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var groupName by remember { mutableStateOf("") }
    var requestId by remember { mutableStateOf(UUID.randomUUID().toString()) }
    val selected = remember { mutableStateListOf<String>() }
    val matching = state.agents.filter { query.isEmpty() || (it.name ?: "").contains(query, true) || (it.title ?: "").contains(query, true) }

    fun create(kind: String, ids: List<String>, title: String?, rid: String) {
        busy = true; error = null
        scope.launch {
            try { onOpenChat(world.createConversation(kind, ids, title, rid).id) }
            catch (e: Throwable) { if (!e.isCancellation) error = e.userMessage }
            busy = false; busyAgent = null
        }
    }

    val title = when (step) { Step.List -> "New chat"; Step.Members -> "New group"; Step.Review -> "Confirm group" }
    val back: () -> Unit = {
        if (step == Step.List) { if (!busy) onDismiss() }
        else { error = null; step = if (step == Step.Review) Step.Members else Step.List }
    }

    ModalBottomSheet(
        onDismissRequest = { if (!busy) onDismiss() }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = c.canvas, contentColor = c.fg, dragHandle = null,
    ) {
        Column(Modifier.fillMaxHeight(0.92f).fillMaxWidth().padding(bottom = 12.dp)) {
            PageHeader(title, onBack = back, leading = if (step == Step.List) PageLeading.Cancel else PageLeading.Back)
            Column(
                Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                if (state.agents.isEmpty()) {
                    EmptyAccount(onNewAgent)
                } else when (step) {
                    Step.List -> {
                        GroupedSection {
                            GroupedRow("New group", icon = JunoIcons.Users, marker = RowMarker.Chevron, onClick = { if (!busy) step = Step.Members })
                            GroupedRow("New agent", icon = JunoIcons.UserPlus, marker = RowMarker.Chevron, onClick = { if (!busy) onNewAgent() })
                        }
                        error?.let { SettingsError("Couldn't create chat: $it") }
                        GroupedSection(header = "Agents") {
                            if (matching.isEmpty()) SettingsEmpty("No matching agents")
                            matching.forEach { agent ->
                                AgentChoice(agent, subtitle = agent.title ?: state.doingLine(agent), trailing = {
                                    if (busyAgent == agent.id) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = c.fgMuted)
                                }) {
                                    if (busy) return@AgentChoice
                                    val existing = state.directConversation(agent.id)
                                    if (existing != null) onOpenChat(existing.id) else { busyAgent = agent.id; create("direct", listOf(agent.id), null, UUID.randomUUID().toString()) }
                                }
                            }
                        }
                    }
                    Step.Members -> {
                        GroupedSection(footer = "Selected ${selected.size} of 6. Choose 2 to 6 agents.") {
                            matching.forEach { agent ->
                                val on = agent.id in selected
                                AgentChoice(agent, subtitle = agent.title ?: state.doingLine(agent), trailing = {
                                    Icon(if (on) JunoIcons.CheckCircle else JunoIcons.Circle, null, tint = if (on) c.fg else c.fgSubtle, modifier = Modifier.size(22.dp))
                                }) {
                                    if (on) selected.remove(agent.id) else if (selected.size < 6) selected.add(agent.id)
                                    requestId = UUID.randomUUID().toString()
                                }
                            }
                        }
                        JunoButton("Next", { step = Step.Review }, Modifier.fillMaxWidth(), enabled = selected.size in 2..6)
                    }
                    Step.Review -> {
                        val members = selected.mapNotNull { state.agent(it) }
                        val fallback = members.mapNotNull { it.name }.joinToString(", ")
                        JunoTextField(groupName, { groupName = it; requestId = UUID.randomUUID().toString() }, "Group name", Modifier.fillMaxWidth())
                        GroupedSection(header = "Members", footer = "Name left empty: $fallback. Mention an agent to get a reply.") {
                            members.forEach { agent -> AgentChoice(agent, subtitle = agent.title ?: state.doingLine(agent), trailing = {}) {} }
                        }
                        error?.let { SettingsError("Couldn't create group: $it") }
                        JunoButton(if (busy) "Creating…" else "Create group", { create("room", selected.toList(), groupName.trim().ifEmpty { null }, requestId) }, Modifier.fillMaxWidth(), enabled = !busy)
                    }
                }
            }
            if (state.agents.isNotEmpty() && step != Step.Review) {
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                    GroupedSearchField(query, "Search agents", onChange = { query = it })
                }
            }
        }
    }
}

/** One agent as a grouped row: avatar, name, its role or what it is doing; [trailing] is the check, spinner or nothing. */
@Composable
private fun AgentChoice(agent: Agent, subtitle: String, trailing: @Composable () -> Unit, onClick: () -> Unit) {
    GroupedRow(
        agent.name ?: "Agent",
        subtitle = subtitle.takeIf { it.isNotEmpty() },
        leading = { AgentAvatar(agent, AvatarSize.md, animated = false) },
        trailing = { trailing() },
        onClick = onClick,
    )
}

/** No agents yet: one picture, one line, one way forward. */
@Composable
private fun EmptyAccount(onCreate: () -> Unit) {
    val c = JunoTheme.colors
    Column(Modifier.fillMaxWidth().padding(vertical = 32.dp), horizontalAlignment = androidx.compose.ui.Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(20.dp)) {
        AgentAvatar(Agent(id = "new-chat-empty", avatar = io.github.nigelleong0703.juno.contract.AvatarSpec(character = "mint")), 112.dp)
        Text("Chats start with an agent", color = c.fg, style = SystemText.headline)
        JunoButton("Create your first agent", onCreate, Modifier.fillMaxWidth(), ButtonVariant.Primary)
    }
}
