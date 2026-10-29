package io.github.nigelleong0703.juno.ui.settings.models

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.EffectiveTier
import io.github.nigelleong0703.juno.contract.ModelCatalog
import io.github.nigelleong0703.juno.contract.TierRow
import androidx.compose.ui.text.style.TextOverflow
import io.github.nigelleong0703.juno.state.PLATFORM_KEY
import io.github.nigelleong0703.juno.state.TIER_KEYS
import io.github.nigelleong0703.juno.ui.components.ButtonSize
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.GroupedChoiceRow
import io.github.nigelleong0703.juno.ui.components.GroupedPage
import io.github.nigelleong0703.juno.ui.components.GroupedRow
import io.github.nigelleong0703.juno.ui.components.GroupedSection
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.components.RowMarker
import io.github.nigelleong0703.juno.ui.settings.SettingsError
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.SystemText
import kotlinx.coroutines.launch

/** What the owner sees for one of the four jobs (`settings.models.tiers`). */
private data class TierInfo(val title: String, val blurb: String)

private val TIER_INFO = mapOf(
    "chat" to TierInfo("Chat", "When you talk to it. Fast replies."),
    "task" to TierInfo("Tasks", "Work it does on its own: sub-tasks, routines, reminders, background jobs."),
    "deep" to TierInfo("Hard problems", "When it decides something needs deep thinking."),
    "fast" to TierInfo("Quick jobs", "Small sub-tasks it decides are simple. Cheaper and faster."),
)

private fun effortLabel(effort: String) = if (effort == "none") "No thinking" else effort.replaceFirstChar { it.uppercase() }

private fun modelName(catalogs: Map<String, ModelCatalog>, providerId: String?, modelId: String): String =
    catalogs[providerId ?: PLATFORM_KEY]?.items?.firstOrNull { it.id == modelId }?.name ?: modelId

/** The four rows under "What each job runs on". A row opens [TierEditorPage]. */
@Composable
fun TierRows(vm: ModelsViewModel, onOpen: (String) -> Unit) {
    val settings by vm.settings.collectAsState()
    val catalogs by vm.catalogs.collectAsState()
    val effective = settings?.effectiveTiers
    fun row(key: String): EffectiveTier? = when (key) {
        "chat" -> effective?.chat
        "task" -> effective?.task
        "deep" -> effective?.deep
        else -> effective?.fast
    }

    // The names come from the catalogs: load every provider a row runs on.
    val providerIds = TIER_KEYS.mapNotNull { k -> row(k)?.takeIf { it.modelId != null }?.let { it.providerId ?: PLATFORM_KEY } }.distinct()
    LaunchedEffect(providerIds) { providerIds.forEach { vm.loadCatalog(it) } }

    GroupedSection(header = "What each job runs on") {
        TIER_KEYS.forEach { key ->
            val info = TIER_INFO.getValue(key)
            val e = row(key)
            GroupedRow(
                info.title, subtitle = info.blurb, marker = RowMarker.Chevron,
                extra = {
                    val c = JunoTheme.colors
                    val model = e?.modelId?.let { modelName(catalogs, e.providerId, it) }
                    // Only the model name truncates; the effort and the Default tag always stay visible.
                    Row {
                        if (model != null) {
                            Text(model, style = SystemText.footnote, color = c.fgMuted, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                        }
                        e?.effort?.let { Text(" · ${effortLabel(it)}", style = SystemText.footnote, color = c.fgMuted, maxLines = 1, softWrap = false) }
                        if (e == null || e.source == "default") Text(if (model != null) "  Default" else "Default", style = SystemText.footnote, color = c.fgSubtle, maxLines = 1, softWrap = false)
                    }
                },
                onClick = if (settings != null) ({ onOpen(key) }) else null,
            )
        }
    }
}

/**
 * One row's model and thinking level. The thinking levels are the ones the chosen model's catalog lists; with no model
 * chosen they come from the model the row uses now (Quick jobs has none to go on, so it waits for a model).
 */
@Composable
fun TierEditorPage(vm: ModelsViewModel, key: String, onPickModel: () -> Unit, onBack: () -> Unit) {
    val settings by vm.settings.collectAsState()
    val catalogs by vm.catalogs.collectAsState()
    val draft by vm.tierDraft.collectAsState()
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val info = TIER_INFO.getValue(key)

    val effective = settings?.effectiveTiers?.let { t ->
        when (key) { "chat" -> t.chat; "task" -> t.task; "deep" -> t.deep; else -> t.fast }
    }
    LaunchedEffect(draft.providerId, draft.modelId, effective?.providerId, effective?.modelId) {
        if (draft.modelId != null) vm.loadCatalog(draft.providerId ?: PLATFORM_KEY)
        if (effective?.modelId != null) vm.loadCatalog(effective.providerId ?: PLATFORM_KEY)
    }

    val efforts = when {
        draft.modelId != null -> vm.catalogItem(draft.providerId, draft.modelId)?.reasoningEfforts.orEmpty()
        key != "fast" && effective?.modelId != null -> vm.catalogItem(effective.providerId, effective.modelId)?.reasoningEfforts.orEmpty()
        else -> emptyList()
    }
    val saved = vm.savedTiers()[key] ?: TierRow()
    val dirty = draft != saved

    fun commit(row: TierRow) {
        scope.launch {
            busy = true; error = null
            val failure = vm.saveTier(key, row)
            busy = false
            if (failure == null) onBack() else error = failure
        }
    }

    GroupedPage(info.title, onBack) {
        GroupedSection(header = "Model", footer = info.blurb) {
            GroupedRow(
                "Model", value = draft.modelId?.let { modelName(catalogs, draft.providerId, it) } ?: "Default",
                marker = RowMarker.Chevron, onClick = onPickModel,
            )
        }
        GroupedSection(
            header = "Thinking",
            footer = when {
                key == "fast" && draft.modelId == null -> "Choose a model to set its thinking level."
                efforts.isEmpty() -> "This model has no thinking levels to choose."
                else -> null
            },
        ) {
            if (efforts.isNotEmpty()) {
                GroupedChoiceRow("Default", selected = draft.effort == null, onClick = { vm.pickTierEffort(null) })
                efforts.forEach { e -> GroupedChoiceRow(effortLabel(e), selected = draft.effort == e, onClick = { vm.pickTierEffort(e) }) }
            }
        }
        error?.let { SettingsError(it) }
        GroupedSection {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                JunoButton(
                    "Reset to default", { commit(TierRow()) },
                    enabled = (saved != TierRow() || draft != TierRow()) && !busy,
                    variant = ButtonVariant.Secondary, size = ButtonSize.Regular,
                )
                JunoButton("Save", { commit(draft) }, enabled = dirty && !busy, variant = ButtonVariant.Primary, size = ButtonSize.Regular)
            }
        }
    }
}
