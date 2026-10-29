package io.github.nigelleong0703.juno.ui.agents

import androidx.compose.foundation.background
import io.github.nigelleong0703.juno.ui.components.FormField
import io.github.nigelleong0703.juno.ui.components.FormTextField
import io.github.nigelleong0703.juno.ui.components.JunoSheet
import io.github.nigelleong0703.juno.ui.components.agentCharacter
import io.github.nigelleong0703.juno.ui.components.AgentAvatar
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Agent
import io.github.nigelleong0703.juno.contract.AvatarSpec
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.saveAgentProfile
import io.github.nigelleong0703.juno.ui.character.CharacterSprite
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.launch

/** "Edit agent": character, name (required) and role. Save sends only name, title and avatar and blocks dismissal (spec 2.14). */
@Composable
fun AgentEditSheet(agentId: String, onDismiss: () -> Unit) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val scope = rememberCoroutineScope()
    val c = JunoTheme.colors
    val agent = state.agent(agentId)
    var name by remember { mutableStateOf(agent?.name.orEmpty()) }
    var role by remember { mutableStateOf(agent?.title.orEmpty()) }
    var character by remember { mutableStateOf(agentCharacter(agent)) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun save() = scope.launch {
        saving = true; error = null
        try {
            world.saveAgentProfile(agentId, name, role, (agent?.avatar ?: AvatarSpec()).copy(character = character))
            onDismiss()
        } catch (e: Throwable) {
            if (e.isCancellation) throw e
            error = e.userMessage; saving = false
        }
    }

    JunoSheet("Edit agent", onDismiss, long = true, primary = "Save", primaryEnabled = name.isNotBlank(), loading = saving, onPrimary = { save() }) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            AgentAvatar(Agent(id = agentId, avatar = AvatarSpec(character = character)), 104.dp)
            Text(name.trim().ifEmpty { "Your agent" }, style = junoText(TextSize.Lg, FontWeight.SemiBold), color = c.fg, maxLines = 2, textAlign = TextAlign.Center)
            CharacterPicker(agentId, character) { character = it }
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                FormField("Name") { FormTextField(name, { name = it }, "Agent name") }
                FormField("Role", optional = true) { FormTextField(role, { role = it }, "What this agent does") }
                error?.let { Text(it, style = junoText(TextSize.Sm), color = JunoStatus.danger) }
            }
        }
    }
}

/** The six-character selector (iOS `AvatarCharacterPicker`), three per row. */
@Composable
fun CharacterPicker(agentId: String, selected: String, onSelect: (String) -> Unit) {
    val c = JunoTheme.colors
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Choose avatar", style = junoText(TextSize.Lg, FontWeight.SemiBold), color = c.fg)
        CharacterSprite.order.chunked(3).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                row.forEach { name ->
                    val on = name == selected
                    val shape = RoundedCornerShape(Radius.lg)
                    Column(
                        Modifier.weight(1f).height(96.dp).background(if (on) c.selected else c.panel, shape).border(if (on) 1.5.dp else 1.dp, if (on) c.fg.copy(alpha = 0.48f) else c.border, shape)
                            .clickable { onSelect(name) },
                        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
                    ) {
                        Box(Modifier.size(64.dp), contentAlignment = Alignment.Center) { AgentAvatar(Agent(id = agentId, avatar = AvatarSpec(character = name)), 56.dp) }
                        Text(name.replaceFirstChar { it.uppercase() }, style = junoText(TextSize.Xs, if (on) FontWeight.SemiBold else FontWeight.Medium), color = c.fg)
                    }
                }
            }
        }
    }
}
