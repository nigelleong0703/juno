@file:OptIn(ExperimentalMaterial3Api::class)

package io.github.nigelleong0703.juno.ui.settings.models

import io.github.nigelleong0703.juno.ui.components.GroupedRow
import io.github.nigelleong0703.juno.ui.components.GroupedSection
import androidx.compose.material3.ExperimentalMaterial3Api
import io.github.nigelleong0703.juno.ui.components.JunoTextField

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.BuiltinModelProvider
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.ProviderDisplay
import io.github.nigelleong0703.juno.state.loadBuiltinProviders
import io.github.nigelleong0703.juno.ui.settings.ShowMoreButton
import io.github.nigelleong0703.juno.ui.theme.JunoTheme

/**
 * Pick a provider to add (iOS AddProviderSheet, ModelSettings.swift:200-299). Searchable; with no search: ChatGPT, the custom
 * and System One rows, "Popular" in a fixed order, then every built-in behind "Show all". On first run the custom and
 * System One rows stay hidden until "Other options" (spec 2.3).
 */
@Composable
fun AddProviderSheet(
    vm: ModelsViewModel,
    firstRun: Boolean,
    onDismiss: () -> Unit,
    onForm: (ProviderForm) -> Unit,
    onChatGpt: () -> Unit,
) {
    val world = LocalWorld.current
    val builtins by produceState<List<BuiltinModelProvider>>(emptyList()) {
        value = runCatching { world.loadBuiltinProviders() }.getOrDefault(emptyList())
    }
    var query by remember { mutableStateOf("") }
    var more by remember { mutableStateOf(!firstRun) }
    var showAll by remember { mutableStateOf(false) }
    val popular = ProviderDisplay.popular.mapNotNull { id -> builtins.firstOrNull { it.id == id } }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = JunoTheme.colors.card) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
            SheetTitle("Add provider")
            JunoTextField(query, { query = it }, "Search providers", Modifier.fillMaxWidth().padding(horizontal = 20.dp))
            if (query.isNotBlank()) {
                val hits = builtins.filter { it.name.orEmpty().contains(query.trim(), true) || it.id.contains(query.trim(), true) }
                GroupedSection { hits.forEach { builtinRow(it, onForm) } }
                if (hits.isEmpty()) io.github.nigelleong0703.juno.ui.settings.SettingsEmpty("No providers match.")
                return@Column
            }
            GroupedSection { GroupedRow("Continue with ChatGPT", onClick = { onDismiss(); onChatGpt() }) }
            if (more) {
                GroupedSection {
                    GroupedRow("Custom endpoint", onClick = { onForm(ProviderForm.Custom) })
                    GroupedRow("System One", onClick = { onForm(ProviderForm.SystemOne) })
                }
            } else {
                ShowMoreButton("Other options") { more = true }
            }
            if (popular.isNotEmpty()) {
                GroupedSection(header = "Popular") { popular.forEach { builtinRow(it, onForm) } }
            }
            if (builtins.isNotEmpty()) {
                if (showAll) {
                    GroupedSection(header = "All providers") { builtins.forEach { builtinRow(it, onForm) } }
                } else {
                    ShowMoreButton("Show all ${builtins.size} providers") { showAll = true }
                }
            }
        }
    }
}

@Composable
private fun builtinRow(p: BuiltinModelProvider, onForm: (ProviderForm) -> Unit) {
    GroupedRow(p.name ?: p.id, onClick = { onForm(ProviderForm.Builtin(p.id, p.name ?: p.id)) })
}
