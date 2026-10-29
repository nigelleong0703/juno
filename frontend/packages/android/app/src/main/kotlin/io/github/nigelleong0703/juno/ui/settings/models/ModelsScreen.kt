@file:OptIn(ExperimentalMaterial3Api::class)

package io.github.nigelleong0703.juno.ui.settings.models

import io.github.nigelleong0703.juno.ui.components.GroupedPage
import io.github.nigelleong0703.juno.ui.components.GroupedRow
import io.github.nigelleong0703.juno.ui.components.GroupedSection
import androidx.compose.material3.ExperimentalMaterial3Api

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import io.github.nigelleong0703.juno.ui.components.JunoIcons
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.SystemText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import io.github.nigelleong0703.juno.contract.ModelProvider
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.ProviderDisplay
import io.github.nigelleong0703.juno.ui.components.ConfirmDialog
import io.github.nigelleong0703.juno.ui.components.JunoTextField
import io.github.nigelleong0703.juno.ui.settings.SettingsEmpty
import io.github.nigelleong0703.juno.ui.settings.SettingsError
import io.github.nigelleong0703.juno.ui.settings.ShowMoreButton
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.launch

/** The Models page (iOS ModelSettings.swift): providers, default model, web search, background models. */
@Composable
fun ModelsScreen(onBack: () -> Unit) {
    val world = LocalWorld.current
    val vm: ModelsViewModel = viewModel { ModelsViewModel(world) }
    var pick by remember { mutableStateOf<PickKind?>(null) }
    var tier by remember { mutableStateOf<String?>(null) }
    var sheet by remember { mutableStateOf<ModelsSheet?>(null) }

    // A long model list is a sub-page of this flow (Muse), not a sheet: system back returns to the Models page first.
    val kind = pick
    val tierKey = tier
    if (kind != null) {
        BackHandler { pick = null }
        ModelPickerPage(vm, kind, onBack = { pick = null })
    } else if (tierKey != null) {
        BackHandler { tier = null }
        TierEditorPage(vm, tierKey, onPickModel = { pick = PickKind.Tier }, onBack = { tier = null })
    } else {
        ModelsRoot(vm, onBack = onBack, onPick = { pick = it }, onTier = { vm.openTier(it); tier = it }, onSheet = { sheet = it })
        ModelsSheets(vm, sheet, onSheet = { sheet = it })
    }
}

@Composable
private fun ModelsRoot(vm: ModelsViewModel, onBack: () -> Unit, onPick: (PickKind) -> Unit, onTier: (String) -> Unit, onSheet: (ModelsSheet?) -> Unit) {
    val list by vm.providers.collectAsState()
    val error by vm.error.collectAsState()
    val all = list?.providers.orEmpty()
    var showAll by remember { mutableStateOf(false) }
    GroupedPage("Models", onBack) {
        error?.let { SettingsError(it) }
        if (all.isEmpty() && list != null) {
            SettingsEmpty(
                if (list?.platformDefault == true) "Your agents use the service default. Add your own provider to choose a model."
                else "Your agents need a model provider. Add one with your own API key or ChatGPT subscription.",
            )
        }
        if (all.isNotEmpty()) {
            GroupedSection(
                header = "Your providers",
                footer = "Your agents talk to models through your own API key or ChatGPT subscription.",
            ) {
                val shown = if (showAll) all else all.take(PROVIDER_CAP)
                shown.forEach { p -> ProviderRow(p, onClick = { onSheet(ModelsSheet.Actions(p)) }) }
                if (all.size > PROVIDER_CAP) {
                    ShowMoreButton(if (showAll) "Show fewer" else "Show ${all.size - PROVIDER_CAP} more") { showAll = !showAll }
                }
            }
        }
        GroupedSection {
            GroupedRow("Add provider", icon = JunoIcons.Plus, onClick = { onSheet(ModelsSheet.Add) })
        }
        DefaultModelSection(vm, providers = all, onPickModel = { onPick(PickKind.Default) })
        WebSearchSection(vm)
        TierRows(vm, onOpen = onTier)
        BackgroundModelRows(vm, onPick = onPick)
    }
}

/**
 * A provider's row: name, the type line, then the status with a green check when the key is saved (iOS "Key saved").
 * The type and status lines follow [ProviderDisplay] (ModelSettings.swift:90-139).
 */
@Composable
private fun ProviderRow(p: ModelProvider, onClick: () -> Unit) {
    val (status, warning) = ProviderDisplay.status(p)
    GroupedRow(
        title = p.name ?: p.id,
        subtitle = ProviderDisplay.typeLine(p),
        onClick = onClick,
        extra = { ProviderStatus(status, warning) },
    )
}

@Composable
private fun ProviderStatus(status: String, warning: Boolean) {
    val c = JunoTheme.colors
    if (warning) {
        Text(status, style = SystemText.footnote, color = JunoStatus.warning)
    } else {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(JunoIcons.CheckCircle, contentDescription = null, tint = JunoStatus.success, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(4.dp))
            Text(status, style = SystemText.footnote, color = JunoStatus.success)
        }
    }
}

@Composable
private fun ModelsSheets(vm: ModelsViewModel, sheet: ModelsSheet?, onSheet: (ModelsSheet?) -> Unit) {
    val close = { onSheet(null) }
    when (val s = sheet) {
        null -> {}
        ModelsSheet.Add -> AddProviderSheet(vm, firstRun = false, onDismiss = close, onForm = { onSheet(ModelsSheet.Form(it)) }, onChatGpt = { onSheet(ModelsSheet.ChatGpt) })
        is ModelsSheet.Form -> ProviderKeySheet(vm, s.form, onDismiss = close, onChatGpt = { onSheet(ModelsSheet.ChatGpt) })
        ModelsSheet.ChatGpt -> ChatGptSignInSheet(vm, onDismiss = close)
        is ModelsSheet.Actions -> ProviderActionsSheet(vm, s.provider, onDismiss = close, onRename = { onSheet(ModelsSheet.Rename(s.provider)) }, onReplace = { onSheet(ModelsSheet.ReplaceKey(s.provider)) }, onChatGpt = { onSheet(ModelsSheet.ChatGpt) })
        is ModelsSheet.Rename -> RenameProviderDialog(vm, s.provider, onDismiss = close)
        is ModelsSheet.ReplaceKey -> ReplaceKeySheet(vm, s.provider, onDismiss = close)
    }
}

/** The screens a sheet can show from the Models page. */
internal sealed interface ModelsSheet {
    data object Add : ModelsSheet
    data class Form(val form: ProviderForm) : ModelsSheet
    data object ChatGpt : ModelsSheet
    data class Actions(val provider: ModelProvider) : ModelsSheet
    data class Rename(val provider: ModelProvider) : ModelsSheet
    data class ReplaceKey(val provider: ModelProvider) : ModelsSheet
}

/** Which model the picker page chooses. */
enum class PickKind { Default, Tier, SystemOne }

/** The cap on the provider list before "Show N more" (iOS ModelSettings.swift:17). */
internal const val PROVIDER_CAP = 5

/** Actions for one provider, opened from its row: rename, replace the key or sign in again, remove. */
@Composable
private fun ProviderActionsSheet(
    vm: ModelsViewModel,
    p: ModelProvider,
    onDismiss: () -> Unit,
    onRename: () -> Unit,
    onReplace: () -> Unit,
    onChatGpt: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val error by vm.error.collectAsState()
    var confirmRemove by remember { mutableStateOf(false) }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = JunoTheme.colors.card) {
        Column(Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
            Text(p.name ?: p.id, style = junoText(TextSize.Lg, FontWeight.SemiBold), color = JunoTheme.colors.fg, modifier = Modifier.padding(16.dp))
            if (ProviderDisplay.isChatGpt(p) || p.status == ModelProvider.StatusValue.reauthRequired) {
                GroupedRow("Sign in again", onClick = { onDismiss(); onChatGpt() })
            } else {
                GroupedRow("Replace key", onClick = onReplace)
            }
            GroupedRow("Rename", onClick = onRename)
            GroupedRow("Remove", onClick = { confirmRemove = true })
            error?.let { SettingsError(it) }
        }
    }
    if (confirmRemove) {
        ConfirmDialog(
            title = "Remove ${p.name ?: p.id}?",
            body = "The saved key is deleted. Your default model is cleared if it was this provider. This can't be undone.",
            confirm = "Remove",
            onConfirm = {
                confirmRemove = false
                scope.launch { if (vm.remove(p.id) == null) onDismiss() }
            },
            onDismiss = { confirmRemove = false },
        )
    }
}

@Composable
internal fun SheetTitle(text: String) {
    Text(text, style = junoText(TextSize.Lg, FontWeight.SemiBold), color = JunoTheme.colors.fg, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
}
