package io.github.nigelleong0703.juno.ui.agents

import androidx.compose.foundation.layout.Arrangement
import io.github.nigelleong0703.juno.ui.components.FormField
import io.github.nigelleong0703.juno.ui.components.FormTextField
import io.github.nigelleong0703.juno.ui.components.JunoSheet
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.AgentHomeFile
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.homeFiles
import io.github.nigelleong0703.juno.state.isHomeConflict
import io.github.nigelleong0703.juno.state.writeHomeFile
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.launch

private class IdentityField(val file: String, val label: String, val hint: String?, val note: String)

private val fields = listOf(
    IdentityField("IDENTITY.md", "Persona", "Who this agent is.",
        "About this file. This is %@'s persona: who %@ is. It starts from what you set when %@ was created, and only you change it. You can edit it at any time. This note is not part of the file."),
    IdentityField("SOUL.md", "Principles & tone", null,
        "About this file. This is %@'s persona. It sets out the values and tone %@ tries to hold to in every conversation. It starts from what you set when %@ was created, and only you change it. You can edit it at any time. This note is not part of the file."),
    IdentityField("AGENTS.md", "Working instructions", "A \"## When to reach out\" section here controls when this agent messages you on its own.",
        "About this file. These are %@'s working instructions: how %@ does its work and when it reaches out to you on its own. It starts from what you set when %@ was created, and only you change it. You can edit it at any time. This note is not part of the file."),
    IdentityField("TOOLS.md", "Tool notes", null,
        "About this file. These are %@'s notes on its tools and how to use them. It starts from what you set when %@ was created, and only you change it. You can edit it at any time. This note is not part of the file."),
)

/**
 * The agent's four identity files in its home, loaded and saved through /v1/home (spec 2.15). Each save carries the hash
 * it was loaded with; a file changed elsewhere is reloaded, not overwritten. Writes are one by one, no rollback.
 */
@Composable
fun IdentitySheet(agentId: String, onDismiss: () -> Unit) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val scope = rememberCoroutineScope()
    val c = JunoTheme.colors
    val prefix = "agents/$agentId/"
    val agent = state.agent(agentId)
    // Editable unless a creator is recorded and is someone else.
    val canEdit = agent?.createdBy == null || agent.createdBy == state.selfId
    var loaded by remember { mutableStateOf<Map<String, AgentHomeFile>>(emptyMap()) }
    var texts by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var isLoading by remember { mutableStateOf(true) }
    var isSaving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun served(file: String) = loaded[prefix + file]?.content.orEmpty()
    val changed = fields.map { it.file }.filter { texts[it] != served(it) }

    suspend fun load() {
        isLoading = true
        try {
            loaded = world.homeFiles(prefix).mapNotNull { f -> f.path?.let { it to f } }.toMap()
            texts = fields.associate { it.file to served(it.file) }
        } catch (e: Throwable) {
            if (e.isCancellation) throw e
            error = e.userMessage
        }
        isLoading = false
    }
    LaunchedEffect(agentId) { load() }

    suspend fun save() {
        isSaving = true
        error = null
        val conflicts = mutableListOf<String>()
        try {
            for (f in fields.filter { it.file in changed }) {
                try {
                    world.writeHomeFile(prefix + f.file, texts[f.file].orEmpty(), loaded[prefix + f.file]?.hash)
                } catch (e: Throwable) {
                    if (e.isHomeConflict) conflicts += f.label else throw e
                }
            }
        } catch (e: Throwable) {
            if (e.isCancellation) throw e
            error = e.userMessage; isSaving = false; return
        }
        if (conflicts.isEmpty()) { onDismiss(); return }
        load()
        error = "${conflicts.joinToString(", ")} changed elsewhere and was reloaded. Review it and make your edit again."
        isSaving = false
    }

    JunoSheet("Identity", onDismiss, long = true, primary = "Save", primaryEnabled = canEdit && !isLoading && changed.isNotEmpty(), loading = isLoading || isSaving, onPrimary = { scope.launch { save() } }) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Text("The agent's identity files. It reads them at the start of every task.", style = junoText(TextSize.Base), color = c.fgMuted)
            if (!canEdit) Text("Only the person who created this agent can edit its identity.", style = junoText(TextSize.Sm), color = c.fgMuted)
            fields.forEach { f ->
                FormField(f.label, help = f.hint) {
                    Text(f.note.replace("%@", agent?.name ?: "This agent"), style = junoText(TextSize.Xs), color = c.fgSubtle)
                    FormTextField(texts[f.file].orEmpty(), { texts = texts + (f.file to it) }, f.label, minLines = 3, maxLines = 14, enabled = canEdit && !isLoading && !isSaving)
                }
            }
            error?.let { Text(it, style = junoText(TextSize.Sm), color = JunoStatus.danger) }
        }
    }
}
