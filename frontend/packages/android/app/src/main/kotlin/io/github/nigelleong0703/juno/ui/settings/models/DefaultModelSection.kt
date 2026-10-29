package io.github.nigelleong0703.juno.ui.settings.models

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.ModelProvider
import io.github.nigelleong0703.juno.state.ProviderDisplay
import io.github.nigelleong0703.juno.ui.components.ButtonSize
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.GroupedChoiceRow
import io.github.nigelleong0703.juno.ui.components.GroupedRow
import io.github.nigelleong0703.juno.ui.components.GroupedSection
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.components.RowMarker
import io.github.nigelleong0703.juno.ui.settings.SettingsError
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.SystemText
import kotlinx.coroutines.launch

/**
 * The default agent model (iOS DefaultModelSection, ModelSettings.swift:538-665): provider (menu) and model (opens the
 * model list) rows, then Clear default and Save inside the same block. Nothing is preselected; Save stays off until the
 * choice differs from what is saved.
 */
@Composable
fun DefaultModelSection(vm: ModelsViewModel, providers: List<ModelProvider>, onPickModel: () -> Unit) {
    val settings by vm.settings.collectAsState()
    val draft by vm.draft.collectAsState()
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var saveError by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(draft.providerId) { draft.providerId?.let { vm.loadCatalog(it) } }

    val saved = settings?.models
    val provider = vm.providerOf(draft.providerId)
    val item = vm.catalogItem(draft.providerId, draft.model)
    val isSaved = draft.providerId == saved?.providerId && draft.model == saved?.defaultModel
    val removed = saved?.providerId != null && providers.none { it.id == saved.providerId }
    val chatProviders = providers.filter(ProviderDisplay::eligibleForChat)

    GroupedSection(header = "Provider", footer = "Applies to every agent's next task. Current tasks keep their model.") {
        chatProviders.forEach { p ->
            GroupedChoiceRow(p.name ?: p.id, selected = p.id == draft.providerId, onClick = { vm.pickProvider(p.id) })
        }
    }
    GroupedSection(header = "Model") {
        GroupedRow(
            "Model", value = item?.name ?: draft.model ?: "Choose a model", marker = RowMarker.Chevron,
            onClick = { if (provider != null) onPickModel() },
        )
    }
    GroupedSection {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            if (saved?.defaultModel != null) {
                Text(
                    "Clear default", style = SystemText.body, color = JunoStatus.danger,
                    modifier = Modifier.clickable { scope.launch { busy = true; saveError = vm.clearDefault(); busy = false } },
                )
            }
            Spacer(Modifier.weight(1f))
            JunoButton(
                "Save", { scope.launch { busy = true; saveError = vm.saveDefault(); busy = false } },
                enabled = draft.providerId != null && draft.model != null && !isSaved && !busy,
                variant = ButtonVariant.Primary, size = ButtonSize.Regular,
            )
        }
    }
    if (removed) SettingsError("The saved default's provider was removed. Pick a model to replace it.")
    saveError?.let { SettingsError(it) }
}

/** Web search: Auto or Juno, from a menu. Disabled until the settings are read (ModelSettings.swift:503-532). */
@Composable
fun WebSearchSection(vm: ModelsViewModel) {
    val settings by vm.settings.collectAsState()
    val scope = rememberCoroutineScope()
    val mode = settings?.models?.webSearch ?: "auto"
    GroupedSection(
        header = "Web search",
        footer = "Agents use the model's built-in search when it has one, and Juno's search otherwise.",
    ) {
        GroupedChoiceRow("Auto", selected = mode == "auto", onClick = { scope.launch { vm.saveWebSearch("auto") } }, subtitle = "The model's built-in search when it has one")
        GroupedChoiceRow("Juno", selected = mode == "juno", onClick = { scope.launch { vm.saveWebSearch("juno") } }, subtitle = "Juno's search for every model")
    }
}
