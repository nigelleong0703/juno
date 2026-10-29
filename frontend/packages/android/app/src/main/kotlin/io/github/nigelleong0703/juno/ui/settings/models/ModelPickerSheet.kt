@file:OptIn(ExperimentalMaterial3Api::class)

package io.github.nigelleong0703.juno.ui.settings.models

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsTopHeight
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
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
import io.github.nigelleong0703.juno.contract.ModelCatalogItem
import io.github.nigelleong0703.juno.contract.ModelProvider
import io.github.nigelleong0703.juno.contract.SystemOneModelChoice
import io.github.nigelleong0703.juno.state.PLATFORM_KEY
import io.github.nigelleong0703.juno.state.ProviderDisplay
import io.github.nigelleong0703.juno.ui.components.GroupedChoiceRow
import io.github.nigelleong0703.juno.ui.components.GroupedSearchField
import io.github.nigelleong0703.juno.ui.components.GroupedSection
import io.github.nigelleong0703.juno.ui.components.PageHeader
import io.github.nigelleong0703.juno.ui.components.PageLeading
import io.github.nigelleong0703.juno.ui.settings.SettingsEmpty
import io.github.nigelleong0703.juno.ui.settings.SettingsError
import io.github.nigelleong0703.juno.ui.settings.ShowMoreButton
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import kotlinx.coroutines.launch

/** Background and tier pickers show this many models per provider before "Show N more" (BackgroundModels.swift:116). */
internal const val BACKGROUND_CAP = 8

/**
 * The model list as a full-screen sub-page of the Models page (Muse: a long list opens a page of radio rows, not a
 * menu). Default and Tier: picking sets the draft and returns; the save is separate. System One: picking saves at once.
 */
@Composable
fun ModelPickerPage(vm: ModelsViewModel, kind: PickKind, onBack: () -> Unit) {
    Column(Modifier.fillMaxSize().navigationBarsPadding()) {
        Spacer(Modifier.windowInsetsTopHeight(WindowInsets.statusBars))
        PageHeader(kind.title(), onBack = onBack, leading = PageLeading.Back)
        ModelPickerBody(vm, kind, onDone = onBack, modifier = Modifier.weight(1f))
    }
}

/** The model list in a bottom sheet, for the onboarding gate's "Show all models". */
@Composable
fun ModelPickerSheet(vm: ModelsViewModel, kind: PickKind, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = JunoTheme.colors.canvas, dragHandle = null) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.92f).padding(bottom = 12.dp)) {
            PageHeader(kind.title(), onBack = onDismiss, leading = PageLeading.Close)
            ModelPickerBody(vm, kind, onDone = onDismiss, modifier = Modifier.weight(1f))
        }
    }
}

private fun PickKind.title(): String = when (this) {
    PickKind.Default -> "Default model"
    PickKind.Tier -> "Choose a model"
    PickKind.SystemOne -> "System One model"
}

/** The scrolling list of providers and models with the search pill at the foot. */
@Composable
private fun ModelPickerBody(vm: ModelsViewModel, kind: PickKind, onDone: () -> Unit, modifier: Modifier = Modifier) {
    val providers by vm.providers.collectAsState()
    val catalogs by vm.catalogs.collectAsState()
    val settings by vm.settings.collectAsState()
    val draft by vm.draft.collectAsState()
    val tierDraft by vm.tierDraft.collectAsState()
    val scope = rememberCoroutineScope()
    var query by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var expanded by remember { mutableStateOf(setOf<String>()) }

    val background = kind != PickKind.Default
    // A tier row can also run on the platform's own models, listed first as "Juno".
    val platform = if (kind == PickKind.Tier && providers?.platformDefault == true) listOf(ModelProvider(id = PLATFORM_KEY, name = "Juno")) else emptyList()
    val eligible = platform + providers?.providers.orEmpty().filter { eligibleFor(kind, it) }
    LaunchedEffect(eligible.map { it.id }) {
        eligible.forEach { p -> vm.loadCatalog(p.id)?.let { loadError = it } }
    }

    val current: SystemOneModelChoice? = when (kind) {
        PickKind.Default -> SystemOneModelChoice(draft.providerId, draft.model)
        PickKind.Tier -> tierDraft.modelId?.let { SystemOneModelChoice(tierDraft.providerId ?: PLATFORM_KEY, it) }
        PickKind.SystemOne -> settings?.models?.systemOneModel
    }

    fun choose(choice: SystemOneModelChoice?) {
        when (kind) {
            PickKind.Default -> { if (choice != null) vm.setDraft(DefaultDraft(choice.providerId, choice.modelId)); onDone() }
            PickKind.Tier -> { vm.pickTierModel(choice); onDone() }
            PickKind.SystemOne -> scope.launch {
                error = vm.saveSystemOne(choice)
                if (error == null) onDone()
            }
        }
    }

    Column(modifier.fillMaxWidth()) {
        Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            loadError?.let { SettingsError(it) }
            error?.let { SettingsError(it) }
            if (background && query.isBlank()) {
                GroupedSection {
                    GroupedChoiceRow(if (kind == PickKind.Tier) "Default" else "Auto", selected = current == null, onClick = { choose(null) })
                }
            }
            eligible.forEach { provider ->
                val items = catalogs[provider.id]?.items.orEmpty()
                    .filter { matches(it, query) }
                    .let { list -> if (background) list.sortedByDescending { it.cheap == true } else list }
                if (items.isEmpty()) return@forEach
                val capped = background && provider.id !in expanded
                val shown = if (capped) items.take(BACKGROUND_CAP) else items
                GroupedSection(header = provider.name ?: provider.id) {
                    shown.forEach { model ->
                        GroupedChoiceRow(
                            model.name ?: model.id,
                            selected = current != null && current.providerId == provider.id && current.modelId == model.id,
                            subtitle = if (model.supportsImages == true) "Accepts images" else null,
                            onClick = { choose(SystemOneModelChoice(provider.id, model.id)) },
                        )
                    }
                    if (capped && items.size > BACKGROUND_CAP) {
                        ShowMoreButton("Show ${items.size - BACKGROUND_CAP} more") { expanded = expanded + provider.id }
                    }
                }
            }
            if (eligible.isEmpty()) {
                SettingsEmpty(if (kind == PickKind.SystemOne) "Add a System One provider to choose one." else "Add a provider first.")
            }
        }
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
            GroupedSearchField(query, "Search models", onChange = { query = it })
        }
    }
}

/** The providers a picker offers (see [ProviderDisplay]). */
private fun eligibleFor(kind: PickKind, p: ModelProvider): Boolean =
    if (kind == PickKind.SystemOne) ProviderDisplay.eligibleForSystemOne(p) else ProviderDisplay.eligibleForChat(p)

/** Search matches the model's name or id, ignoring case. */
private fun matches(item: ModelCatalogItem, query: String): Boolean {
    val q = query.trim()
    return q.isEmpty() || (item.name ?: item.id).contains(q, ignoreCase = true) || item.id.contains(q, ignoreCase = true)
}
