package io.github.nigelleong0703.juno.ui.screens.newagent

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import io.github.nigelleong0703.juno.state.createAgent
import io.github.nigelleong0703.juno.ui.agents.CharacterPicker
import io.github.nigelleong0703.juno.ui.components.AgentAvatar
import io.github.nigelleong0703.juno.ui.components.FormField
import io.github.nigelleong0703.juno.ui.components.FormTextField
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.components.PageHeader
import io.github.nigelleong0703.juno.ui.components.PageLeading
import io.github.nigelleong0703.juno.ui.settings.SettingsError
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.launch

/** The avatar preview's id: it only picks the sprite, so it never collides with a real agent. */
private const val PREVIEW_ID = "new-agent-preview"

/**
 * New agent (iOS NewAgentSheet): a name, an optional role and the character. Create makes the agent and its direct chat,
 * then opens the chat; the shell closes this sheet when it navigates there, so success does not close it by hand.
 * Rendered as a bottom sheet by the nav host.
 */
@Composable
fun NewAgentScreen(onClose: () -> Unit) {
    val world = LocalWorld.current
    val scope = rememberCoroutineScope()
    val c = JunoTheme.colors
    var name by remember { mutableStateOf("") }
    var role by remember { mutableStateOf("") }
    var character by remember { mutableStateOf("mint") }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val trimmed = name.trim()

    fun create() {
        if (trimmed.isEmpty() || saving) return
        saving = true; error = null
        scope.launch {
            try { world.createAgent(trimmed, role, AvatarSpec(character = character)) }
            catch (e: Throwable) {
                if (!e.isCancellation) error = "Couldn't create the agent: ${e.userMessage}"
                saving = false
            }
        }
    }

    Column(Modifier.fillMaxWidth().fillMaxHeight(0.92f)) {
        PageHeader(
            "New agent", onBack = onClose, leading = PageLeading.Cancel,
            actions = {
                if (saving) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = c.fgMuted)
                else JunoButton("Create", { create() }, enabled = trimmed.isNotEmpty())
            },
        )
        Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            Column(
                Modifier.fillMaxWidth().padding(top = 12.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                AgentAvatar(Agent(id = PREVIEW_ID, avatar = AvatarSpec(character = character)), 112.dp)
                Text(
                    trimmed.ifEmpty { "Your agent" }, style = junoText(TextSize.Xl, FontWeight.SemiBold), color = c.fg,
                    maxLines = 2, textAlign = TextAlign.Center,
                )
            }
            CharacterPicker(PREVIEW_ID, character) { character = it }
            FormField("Name") { FormTextField(name, { name = it }, "Agent name") }
            FormField("Role", optional = true) { FormTextField(role, { role = it }, "What this agent does") }
            Text(
                "Leave the role empty and Juno suggests one after your first few messages.",
                style = junoText(TextSize.Sm), color = c.fgMuted,
            )
            error?.let { SettingsError(it) }
        }
    }
}
