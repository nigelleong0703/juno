package io.github.nigelleong0703.juno.ui.routines

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Routine
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.agentsData
import io.github.nigelleong0703.juno.state.loadRoutines
import io.github.nigelleong0703.juno.ui.components.AgentAvatar
import io.github.nigelleong0703.juno.ui.components.EmptyLine
import io.github.nigelleong0703.juno.ui.components.GroupedPage
import io.github.nigelleong0703.juno.ui.components.GroupedRow
import io.github.nigelleong0703.juno.ui.components.GroupedSearchField
import io.github.nigelleong0703.juno.ui.components.GroupedSection
import io.github.nigelleong0703.juno.ui.settings.connectors.SegmentedControl
import io.github.nigelleong0703.juno.ui.theme.AvatarSize

private const val VIEW_KEY = "automations.view"

/** Routines: Calendar | List. The choice is remembered per device (iOS `@AppStorage("automations.view")`), default calendar. */
@Composable
fun RoutinesScreen(onBack: () -> Unit) {
    val prefs = LocalContext.current.getSharedPreferences("juno_ui", Context.MODE_PRIVATE)
    var view by remember { mutableStateOf(runCatching { prefs.getString(VIEW_KEY, "calendar") }.getOrNull() ?: "calendar") }
    GroupedPage("Routines", onBack, scrollable = false) {
        SegmentedControl(
            options = listOf("calendar" to "Calendar", "list" to "List"),
            selected = view,
            onSelect = { view = it; runCatching { prefs.edit().putString(VIEW_KEY, it).apply() } },
        )
        if (view == "list") RoutinesList() else CalendarScreen()
    }
}

/** The global routines list: searchable by name, state word on the right, long-press to delete (spec 2.22). */
@Composable
fun RoutinesList() {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val data by world.agentsData.collectAsState()
    var query by remember { mutableStateOf("") }
    var deleting by remember { mutableStateOf<Routine?>(null) }
    LaunchedEffect(Unit) { world.loadRoutines() }
    val rows = data.routines.filter { query.isEmpty() || it.name.orEmpty().contains(query, ignoreCase = true) }
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        GroupedSearchField(query, "Search routines", onChange = { query = it })
        Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState())) {
            if (rows.isEmpty()) EmptyLine("No routines.")
            else GroupedSection {
                rows.forEach { r ->
                    val agent = state.agents.firstOrNull { it.id == r.agentId }
                    GroupedRow(
                        r.name.orEmpty(),
                        subtitle = r.trigger?.human,
                        value = routineStateWord(r),
                        leading = agent?.let { a -> { AgentAvatar(a, AvatarSize.md) } },
                        extra = { RoutineSetupNote(r) },
                        onLongClick = { deleting = r },
                    )
                }
            }
        }
    }
    DeleteRoutineDialog(deleting) { deleting = null }
}
