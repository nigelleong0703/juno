package io.github.nigelleong0703.juno.ui.settings.models

import io.github.nigelleong0703.juno.ui.components.GroupedRow
import io.github.nigelleong0703.juno.ui.components.GroupedSection
import io.github.nigelleong0703.juno.ui.components.RowMarker
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import io.github.nigelleong0703.juno.contract.SystemOneModelChoice
import io.github.nigelleong0703.juno.state.ProviderDisplay
import io.github.nigelleong0703.juno.ui.settings.SettingsEmpty

/**
 * The System One model (iOS BackgroundModels.swift). The row says "Auto" or the chosen model; the footer names what Auto
 * resolves to right now. The fast model is the "Quick jobs" row of [TierRows].
 */
@Composable
fun BackgroundModelRows(vm: ModelsViewModel, onPick: (PickKind) -> Unit) {
    val settings by vm.settings.collectAsState()
    val providers by vm.providers.collectAsState()
    val catalogs by vm.catalogs.collectAsState()
    val models = settings?.models
    val all = providers?.providers.orEmpty()
    val hasSystemOne = all.any(ProviderDisplay::eligibleForSystemOne)

    // The names come from the catalogs: load the chosen provider's list so a row can say the model's name.
    LaunchedEffect(models?.systemOneModel?.providerId) { models?.systemOneModel?.providerId?.let { vm.loadCatalog(it) } }

    fun nameOf(choice: SystemOneModelChoice?): String? {
        val c = choice ?: return null
        return catalogs[c.providerId]?.items?.firstOrNull { it.id == c.modelId }?.name ?: c.modelId
    }

    val systemOneEffective = settings?.effectiveSystemOneModel
    GroupedSection(
        header = "Background models",
        footer = autoLine(systemOneEffective?.source, nameOf(systemOneEffective?.let { SystemOneModelChoice(it.providerId, it.modelId) }), models?.systemOneModel != null) +
            "\nUsed for quick safety judgments, such as before your agent places an order.",
    ) {
        GroupedRow(
            "System One model", value = nameOf(models?.systemOneModel) ?: "Auto", marker = RowMarker.Chevron,
            onClick = if (hasSystemOne) ({ onPick(PickKind.SystemOne) }) else null,
        )
        if (!hasSystemOne) SettingsEmpty("Add a System One provider to choose one.")
    }
}

/** The footer's Auto sentence (BackgroundModels.swift). Only shown while the row is Auto. */
private fun autoLine(source: String?, model: String?, chosen: Boolean): String {
    if (chosen) return ""
    val name = model ?: return "Auto — no model available yet."
    return when (source) {
        "platform" -> "Auto — $name, the service default."
        "fast-model-emulation" -> "Auto — $name, your quick-jobs model stands in."
        else -> "Auto — $name."
    }
}
