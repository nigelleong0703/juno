package io.github.nigelleong0703.juno.ui.memory

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.MemorySearchHit
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.searchMemory
import io.github.nigelleong0703.juno.ui.components.GroupedPage
import io.github.nigelleong0703.juno.ui.components.GroupedRow
import io.github.nigelleong0703.juno.ui.components.GroupedSearchField
import io.github.nigelleong0703.juno.ui.components.GroupedSection
import io.github.nigelleong0703.juno.ui.components.JunoTextField
import io.github.nigelleong0703.juno.ui.components.RowMarker
import io.github.nigelleong0703.juno.ui.components.ShowMore
import io.github.nigelleong0703.juno.ui.components.rememberCloseAction
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.SystemText
import kotlinx.coroutines.delay

/** Where Memory has navigated to: a file (with the search line it was found at, if any) or one of the lists. */
sealed interface MemoryDest {
    data class File(val path: String, val match: MemoryMatch? = null) : MemoryDest
    data object About : MemoryDest
    data object People : MemoryDest
    data object Daily : MemoryDest
    data object Claims : MemoryDest
}

/** The lines of a file a search hit points at. */
data class MemoryMatch(val line: Int, val text: String)

/** The file a memory hit opens (`MemorySearchHit.file`: `memory` or `bank:<name>`); null for a person page, which the hit gives no path for. */
internal fun hitFile(view: String?): String? = when {
    view == "memory" -> "MEMORY.md"
    view?.startsWith("bank:") == true -> "memory/bank/${view.removePrefix("bank:")}.md"
    else -> null
}

/** The label of the view a memory hit is shown in. */
internal fun hitLabel(view: String?): String = when (view) {
    "memory" -> "Memory"
    "bank:circumstances" -> "Circumstances"
    "bank:experiences" -> "Experiences"
    "bank:preferences" -> "Preferences"
    "person" -> "People"
    else -> view.orEmpty()
}

/** Search results shown per step, and the search debounce (iOS `MemoryPage`). */
private const val SEARCH_STEP = 10
private const val SEARCH_DEBOUNCE_MS = 300L

/**
 * The Memory page (iOS `MemoryPage` + `MemoryScreen` routing): the files agents keep about the user, the claims behind
 * them, and memory search. Sub-pages open inside this screen; system back returns to the list first.
 */
@Composable
fun MemoryScreen() {
    var dest by remember { mutableStateOf<MemoryDest?>(null) }
    BackHandler(enabled = dest != null) { dest = null }
    val back: () -> Unit = { dest = null }
    when (val d = dest) {
        null -> MemoryRoot(onOpen = { dest = it })
        is MemoryDest.File -> MemoryFileScreen(d.path, d.match, onBack = back)
        MemoryDest.About -> BankList(onOpen = { dest = it }, onBack = back)
        MemoryDest.People -> PeopleList(onOpen = { dest = it }, onBack = back)
        MemoryDest.Daily -> DailyNotesList(onBack = back)
        MemoryDest.Claims -> ClaimsScreen(onBack = back)
    }
}

/**
 * The Memory root (iOS Features/Memory): the files as grouped rows, Claims in its own section, and the search field
 * pinned at the bottom. A query replaces the rows with the search hits.
 */
@Composable
private fun MemoryRoot(onOpen: (MemoryDest) -> Unit) {
    val world = LocalWorld.current
    val close = rememberCloseAction()
    var query by remember { mutableStateOf("") }
    val trimmed = query.trim()
    var hits by remember { mutableStateOf<List<MemorySearchHit>>(emptyList()) }
    var searchFailed by remember { mutableStateOf(false) }
    var limit by remember { mutableIntStateOf(SEARCH_STEP) }

    // Each new query restarts the search after a short pause (iOS `.task(id: trimmed)`).
    LaunchedEffect(trimmed) {
        hits = emptyList()
        searchFailed = false
        limit = SEARCH_STEP
        if (trimmed.isEmpty()) return@LaunchedEffect
        delay(SEARCH_DEBOUNCE_MS)
        runCatching { world.searchMemory(trimmed) }
            .onSuccess { hits = it }
            .onFailure { searchFailed = true }
    }

    GroupedPage(
        "Memory", onBack = close,
        bottom = { GroupedSearchField(query, "Search memory", onChange = { query = it }) },
    ) {
        if (trimmed.isEmpty()) {
            GroupedSection {
                GroupedRow("Memory", subtitle = "The short sheet every agent reads first", icon = JunoIcons.Brain, marker = RowMarker.Chevron) {
                    onOpen(MemoryDest.File("MEMORY.md"))
                }
                GroupedRow("About you", subtitle = "Circumstances, experiences, preferences", icon = JunoIcons.ContactPage, marker = RowMarker.Chevron) { onOpen(MemoryDest.About) }
                GroupedRow("People", subtitle = "One page per person in your life", icon = JunoIcons.Users, marker = RowMarker.Chevron) { onOpen(MemoryDest.People) }
                GroupedRow("Daily notes", subtitle = "What each agent wrote down, by day", icon = JunoIcons.Calendar, marker = RowMarker.Chevron) { onOpen(MemoryDest.Daily) }
                GroupedRow("Learned reply style", subtitle = "How you like to be answered", icon = JunoIcons.Forum, marker = RowMarker.Chevron) {
                    onOpen(MemoryDest.File("ALIGNMENT_SYNTHESIS.md"))
                }
            }
            GroupedSection {
                GroupedRow("What I know and why", subtitle = "Claims with your own words as proof", icon = JunoIcons.Quote, marker = RowMarker.Chevron) {
                    onOpen(MemoryDest.Claims)
                }
            }
        } else if (searchFailed) {
            MutedMessage("Search failed. Try again.", danger = true)
        } else if (hits.isEmpty()) {
            MutedMessage("Nothing in your memory matches that.")
        } else {
            GroupedSection {
                hits.take(limit).forEach { hit ->
                    val file = hitFile(hit.file)
                    if (file == null) {
                        GroupedRow(hit.text.orEmpty(), subtitle = hitLabel(hit.file))
                    } else {
                        GroupedRow(hit.text.orEmpty(), subtitle = hitLabel(hit.file), marker = RowMarker.Chevron) { onOpen(MemoryDest.File(file)) }
                    }
                }
            }
            ShowMore(shown = limit, total = hits.size, onMore = { limit += SEARCH_STEP })
        }
    }
}

@Composable
internal fun MutedMessage(text: String, danger: Boolean = false) {
    val c = JunoTheme.colors
    Text(text, style = SystemText.body, color = if (danger) JunoStatus.danger else c.fgMuted, modifier = Modifier.padding(vertical = 12.dp))
}
