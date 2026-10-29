@file:OptIn(ExperimentalMaterial3Api::class)

package io.github.nigelleong0703.juno.ui.settings.models

import io.github.nigelleong0703.juno.ui.components.GroupedRow
import io.github.nigelleong0703.juno.ui.components.RowMarker
import io.github.nigelleong0703.juno.ui.components.GroupedSection
import io.github.nigelleong0703.juno.ui.components.ButtonSize
import io.github.nigelleong0703.juno.ui.components.JunoTextField
import androidx.compose.material3.ExperimentalMaterial3Api

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.ModelProvider
import io.github.nigelleong0703.juno.state.ProviderDisplay
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.settings.SettingsError
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.launch

/** Which provider form to show: a built-in (API key only), a custom endpoint, or System One. */
sealed interface ProviderForm {
    data class Builtin(val id: String, val name: String) : ProviderForm
    data object Custom : ProviderForm
    data object SystemOne : ProviderForm
}

private val wireLabels = listOf(
    ModelProvider.WireValue.openaiCompletions to "Chat Completions",
    ModelProvider.WireValue.openaiResponses to "Responses",
)

/**
 * Adds a provider with its key (iOS ProviderKeyForm, ModelSettings.swift:302-407). The key is write-only: it lives in a
 * plain state variable (never rememberSaveable) and is dropped with the sheet.
 */
@Composable
fun ProviderKeySheet(vm: ModelsViewModel, form: ProviderForm, onDismiss: () -> Unit, onChatGpt: () -> Unit = {}) {
    val c = JunoTheme.colors
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var baseUrl by remember { mutableStateOf("") }
    var modelIds by remember { mutableStateOf("") }
    var wire by remember { mutableStateOf(ModelProvider.WireValue.openaiCompletions) }
    var wireOpen by remember { mutableStateOf(false) }
    var apiKey by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    val valid = apiKey.isNotBlank() && when (form) {
        is ProviderForm.Builtin -> true
        ProviderForm.Custom -> name.isNotBlank() && ProviderDisplay.isValidBaseUrl(baseUrl)
        ProviderForm.SystemOne -> name.isNotBlank() && ProviderDisplay.isValidBaseUrl(baseUrl) && ProviderDisplay.parseModelIds(modelIds) != null
    }
    val title = when (form) {
        is ProviderForm.Builtin -> form.name
        ProviderForm.Custom -> "Custom provider"
        ProviderForm.SystemOne -> "System One"
    }

    fun save() {
        if (!valid || busy) return
        busy = true; error = null
        scope.launch {
            val failure = when (form) {
                is ProviderForm.Builtin -> vm.addBuiltin(form.id, apiKey)
                ProviderForm.Custom -> vm.addCustom(name.trim(), baseUrl.trim(), wire, apiKey)
                ProviderForm.SystemOne -> vm.addSystemOne(name.trim(), baseUrl.trim(), ProviderDisplay.parseModelIds(modelIds).orEmpty(), apiKey)
            }
            busy = false
            // The key leaves the state with the sheet; a failure keeps the rest of the form for another try.
            if (failure == null) { apiKey = ""; onDismiss() } else { error = failure; apiKey = "" }
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = c.card) {
        Column(Modifier.fillMaxWidth().padding(bottom = 24.dp), verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(12.dp)) {
            SheetTitle(title)
            if (form == ProviderForm.Custom || form == ProviderForm.SystemOne) JunoTextField(name, { name = it }, "Name", Modifier.fillMaxWidth().padding(horizontal = 20.dp))
            if (form == ProviderForm.Custom || form == ProviderForm.SystemOne) {
                JunoTextField(baseUrl, { baseUrl = it }, if (form == ProviderForm.SystemOne) "Base URL (https://api.typesafe.ai)" else "Base URL", Modifier.fillMaxWidth().padding(horizontal = 20.dp))
            }
            if (form == ProviderForm.SystemOne) JunoTextField(modelIds, { modelIds = it }, "Model ids, comma-separated", Modifier.fillMaxWidth().padding(horizontal = 20.dp))
            if (form == ProviderForm.Custom) {
                GroupedSection {
                    GroupedRow("Protocol", value = wireLabels.first { it.first == wire }.second, marker = RowMarker.Chevron, onClick = { wireOpen = true })
                }
            }
            JunoTextField(apiKey, { apiKey = it }, "API key", Modifier.fillMaxWidth().padding(horizontal = 20.dp), secret = true)
            error?.let { SettingsError(it) }
            Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Stored encrypted and never shown again. You can replace it later.", style = junoText(TextSize.Xs), color = c.fgSubtle, modifier = Modifier.weight(1f))
                JunoButton("Save", ::save, enabled = valid && !busy, size = ButtonSize.Large, variant = ButtonVariant.Primary)
            }
            if (form is ProviderForm.Builtin && form.id == "openai") {
                GroupedSection { GroupedRow("Sign in with ChatGPT instead", onClick = { onDismiss(); onChatGpt() }) }
            }
        }
    }
    if (wireOpen) {
        OptionSheet(
            title = "Protocol",
            options = wireLabels,
            selected = wire,
            onPick = { wire = it ?: wire },
            onDismiss = { wireOpen = false },
        )
    }
}

/** Replace a saved key (ModelSettings.swift:163-193): a secure field, cleared on success, never shown again. */
@Composable
fun ReplaceKeySheet(vm: ModelsViewModel, provider: ModelProvider, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var apiKey by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = JunoTheme.colors.card) {
        Column(Modifier.fillMaxWidth().padding(bottom = 24.dp), verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(12.dp)) {
            SheetTitle("Replace key")
            JunoTextField(apiKey, { apiKey = it }, "New API key", Modifier.fillMaxWidth().padding(horizontal = 20.dp), secret = true)
            error?.let { SettingsError(it) }
            Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                Spacer(Modifier.weight(1f))
                JunoButton(
                    "Save",
                    {
                        busy = true; error = null
                        scope.launch {
                            val failure = vm.replaceKey(provider.id, apiKey)
                            busy = false
                            if (failure == null) { apiKey = ""; onDismiss() } else error = failure
                        }
                    },
                    enabled = apiKey.isNotBlank() && !busy, size = ButtonSize.Large,
                )
            }
        }
    }
}

/** Rename a provider (ModelSettings.swift:76-80, 143-150): an empty name is ignored. */
@Composable
fun RenameProviderDialog(vm: ModelsViewModel, provider: ModelProvider, onDismiss: () -> Unit) {
    val c = JunoTheme.colors
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf(provider.name ?: provider.id) }
    var error by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = onDismiss, containerColor = c.card,
        title = { Text("Rename provider", style = junoText(TextSize.Lg), color = c.fg) },
        text = {
            Column {
                JunoTextField(name, { name = it }, "Name", Modifier.fillMaxWidth().padding(horizontal = 20.dp))
                error?.let { SettingsError(it) }
            }
        },
        confirmButton = {
            TextButton({
                if (name.isBlank()) { onDismiss(); return@TextButton }
                scope.launch { error = vm.rename(provider.id, name.trim()); if (error == null) onDismiss() }
            }) { Text("Save", color = c.fg) }
        },
        dismissButton = { TextButton(onDismiss) { Text("Cancel", color = c.fgMuted) } },
    )
}
