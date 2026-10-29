package io.github.nigelleong0703.juno.ui.settings.connectors

import androidx.compose.runtime.Composable
import io.github.nigelleong0703.juno.contract.Connection
import io.github.nigelleong0703.juno.state.ConnectorRules
import io.github.nigelleong0703.juno.state.ConnectorView
import io.github.nigelleong0703.juno.ui.components.GroupedChoiceRow
import io.github.nigelleong0703.juno.ui.components.GroupedPage
import io.github.nigelleong0703.juno.ui.components.GroupedRow
import io.github.nigelleong0703.juno.ui.components.GroupedSection
import io.github.nigelleong0703.juno.ui.components.JunoIcons
import io.github.nigelleong0703.juno.ui.components.RowMarker
import io.github.nigelleong0703.juno.ui.settings.SettingsEmpty
import io.github.nigelleong0703.juno.ui.settings.SettingsError

/**
 * The connector store (Muse connectors page): a Category row that opens [ConnectorCategoryPage], then "Connected" and
 * "Available" sections of catalog connectors, and the owner's custom servers. The search pill is drawn by
 * [PluginsScreen] and passed in as [query]; the category choice is held there too. The server's unavailable
 * connectors are not listed.
 */
@Composable
fun ConnectorsPage(
    connectors: List<ConnectorView>?,
    connections: List<Connection>,
    loadError: String?,
    query: String,
    category: String?,
    onOpenCategory: () -> Unit,
    onOpen: (String) -> Unit,
    onOpenCustom: (String) -> Unit,
    onAdd: () -> Unit,
) {
    GroupedSection(header = "On your Mac") {
        GroupedRow("Your Mac", subtitle = "Open Juno on your Mac to pair", icon = JunoIcons.Computer, value = "Not set up")
    }

    if (connectors == null) {
        if (loadError != null) SettingsError(loadError) else LoadingLine()
        return
    }
    val matched = ConnectorRules.listed(connectors).filter { ConnectorRules.matches(it, category, query) }

    GroupedSection {
        GroupedRow("Category", value = categoryLabel(category), marker = RowMarker.Chevron, onClick = onOpenCategory)
    }
    loadError?.let { SettingsError(it) }
    if (matched.isEmpty()) SettingsEmpty("No connectors found.")

    val (connected, available) = matched.partition { ConnectorRules.isConnected(it.status) }
    if (connected.isNotEmpty()) {
        GroupedSection(header = "Connected") {
            connected.forEach { connector -> ConnectorRow(connector) { onOpen(connector.id) } }
        }
    }
    if (available.isNotEmpty()) {
        GroupedSection(header = "Available") {
            available.forEach { connector -> ConnectorRow(connector) { onOpen(connector.id) } }
        }
    }

    GroupedSection(
        header = "Custom",
        footer = "Any remote MCP server you add by its address.",
    ) {
        connections.forEach { connection ->
            GroupedRow(title = connection.name.orEmpty(), subtitle = connection.endpoint, marker = RowMarker.Chevron, onClick = { onOpenCustom(connection.id) })
        }
        GroupedRow(title = "Add custom connector", icon = JunoIcons.Plus, onClick = onAdd)
    }
}

/**
 * The Category sub-page of the connector store: one check row per category, "All" first (null). Picking one filters the
 * list and returns to it, so it is a page of its own rather than a list inline above the connectors.
 */
@Composable
fun ConnectorCategoryPage(categories: List<String>, selected: String?, onSelect: (String?) -> Unit, onBack: () -> Unit) {
    GroupedPage(title = "Category", onBack = onBack) {
        GroupedSection {
            GroupedChoiceRow("All", selected = selected == null, onClick = { onSelect(null); onBack() })
            categories.forEach { name ->
                GroupedChoiceRow(categoryLabel(name), selected = selected == name, onClick = { onSelect(name); onBack() })
            }
        }
    }
}

/** The name a category shows: capitalised, and "All" when no category filters the list. */
internal fun categoryLabel(category: String?): String = category?.replaceFirstChar { it.uppercase() } ?: "All"
