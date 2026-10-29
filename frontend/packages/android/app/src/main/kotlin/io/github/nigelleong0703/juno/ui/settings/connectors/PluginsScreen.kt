package io.github.nigelleong0703.juno.ui.settings.connectors

import io.github.nigelleong0703.juno.ui.components.GroupedPage
import io.github.nigelleong0703.juno.ui.components.GroupedSearchField
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import io.github.nigelleong0703.juno.state.ConnectorRules
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.ui.settings.SettingsEmpty

/** The Plugins page: Connectors | Skills, the connector store, and the detail pages it opens. */
enum class PluginsSegment { Connectors, Skills }

/**
 * Settings -> Plugins (iOS `PluginsView`). [connectorId] opens that connector's detail page straight away (a card that
 * names a connector). The lists re-read on every resume, because a sign-in finishes in the browser.
 */
@Composable
fun PluginsScreen(connectorId: String? = null, onBack: () -> Unit) {
    val world = LocalWorld.current
    val model = viewModel<PluginsModel> { PluginsModel(world) }
    val connectors by model.connectors.collectAsState()
    val connections by model.connections.collectAsState()
    val skills by model.skills.collectAsState()
    val loadError by model.error.collectAsState()

    var segment by rememberSaveable { mutableStateOf(PluginsSegment.Connectors) }
    var openId by rememberSaveable(connectorId) { mutableStateOf(connectorId) }
    var openCustomId by rememberSaveable { mutableStateOf<String?>(null) }
    var adding by rememberSaveable { mutableStateOf(false) }
    var query by rememberSaveable { mutableStateOf("") }
    var category by rememberSaveable { mutableStateOf<String?>(null) }
    var choosingCategory by rememberSaveable { mutableStateOf(false) }

    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner, model) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) model.refresh()
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(segment) {
        if (segment == PluginsSegment.Skills) model.refreshSkills()
    }
    // Back closes a detail page first, as a pushed page would.
    BackHandler {
        when {
            openId != null -> openId = null
            openCustomId != null -> openCustomId = null
            choosingCategory -> choosingCategory = false
            else -> onBack()
        }
    }

    val detailId = openId
    val customId = openCustomId
    when {
        detailId != null -> {
            val connector = connectors?.firstOrNull { it.id == detailId }
            if (connector != null) {
                ConnectorDetailScreen(connector, model) { openId = null }
            } else {
                GroupedPage(title = "Connector", onBack = { openId = null }) {
                    if (connectors == null) LoadingLine() else SettingsEmpty("Not set up on this server.")
                }
            }
        }
        customId != null -> CustomConnectorScreen(customId, model) { openCustomId = null }
        choosingCategory -> ConnectorCategoryPage(
            categories = ConnectorRules.categories(ConnectorRules.listed(connectors.orEmpty())),
            selected = category,
            onSelect = { category = it },
            onBack = { choosingCategory = false },
        )
        else -> GroupedPage(
            title = if (segment == PluginsSegment.Connectors) "Connectors" else "Skills",
            onBack = onBack,
        ) {
            if (segment == PluginsSegment.Connectors) GroupedSearchField(query, "Search connectors", onChange = { query = it })
            SegmentedControl(
                options = listOf(PluginsSegment.Connectors to "Connectors", PluginsSegment.Skills to "Skills"),
                selected = segment,
                onSelect = { segment = it },
            )
            when (segment) {
                PluginsSegment.Connectors -> ConnectorsPage(
                    connectors = connectors,
                    connections = connections,
                    loadError = loadError,
                    query = query,
                    category = category,
                    onOpenCategory = { choosingCategory = true },
                    onOpen = { openId = it },
                    onOpenCustom = { openCustomId = it },
                    onAdd = { adding = true },
                )
                PluginsSegment.Skills -> SkillsPage(skills, loadError)
            }
        }
    }
    if (adding) AddCustomConnectorSheet(model) { adding = false }
}
