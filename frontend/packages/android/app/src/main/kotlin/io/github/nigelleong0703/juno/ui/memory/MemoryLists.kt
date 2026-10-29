package io.github.nigelleong0703.juno.ui.memory

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.shape.RoundedCornerShape
import io.github.nigelleong0703.juno.ui.theme.Radius
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.state.DailyNotes
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.PersonPage
import io.github.nigelleong0703.juno.state.homeFiles
import io.github.nigelleong0703.juno.ui.components.ShowMore
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** About you: the three bank files. */
@Composable
fun BankList(onOpen: (MemoryDest) -> Unit, onBack: () -> Unit) {
    val c = JunoTheme.colors
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        MemoryBar("About you", onBack = onBack)
        Column {
            BANK_FILES.forEach { (key, title) ->
                Row(
                    Modifier.fillMaxWidth().clickable { onOpen(MemoryDest.File("memory/bank/$key.md")) }.padding(vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(title, style = junoText(TextSize.Md), color = c.fg, modifier = Modifier.weight(1f))
                    Icon(JunoIcons.ChevronRight, contentDescription = null, tint = c.fgSubtle)
                }
            }
        }
        Text(
            "What your agents learned about you, sorted into three files. Edit any of them.",
            style = junoText(TextSize.Xs), color = c.fgSubtle,
        )
    }
}

/** People pages sorted by name, 20 at a time. Each page opens in the file screen. */
@Composable
fun PeopleList(onOpen: (MemoryDest) -> Unit, onBack: () -> Unit) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    var people by remember { mutableStateOf<List<Pair<String, String>>?>(null) }
    var limit by remember { mutableIntStateOf(PEOPLE_STEP) }
    LaunchedEffect(state.homeRevision) {
        people = runCatching {
            world.homeFiles("people/")
                .mapNotNull { f -> f.path?.let { it to PersonPage.name(it, f.content.orEmpty()) } }
                .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.second })
        }.getOrDefault(emptyList())
    }
    val list = people
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 8.dp)) {
        MemoryBar("People", onBack = onBack)
        LazyColumn(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            if (list != null && list.isEmpty()) item { Text("No people pages yet.", style = junoText(TextSize.Base), color = c.fgMuted, modifier = Modifier.padding(vertical = 12.dp)) }
            list?.take(limit)?.forEach { (path, name) ->
                item(key = path) {
                    Row(Modifier.fillMaxWidth().clickable { onOpen(MemoryDest.File(path)) }.padding(vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(name, style = junoText(TextSize.Md), color = c.fg, modifier = Modifier.weight(1f))
                        Icon(JunoIcons.ChevronRight, contentDescription = null, tint = c.fgSubtle)
                    }
                }
            }
            item { ShowMore(shown = limit, total = list?.size ?: 0, onMore = { limit += PEOPLE_STEP }) }
            item { Text("One page per person in your life. Open one to read or edit it.", style = junoText(TextSize.Xs), color = c.fgSubtle, modifier = Modifier.padding(top = 12.dp)) }
        }
    }
}

private const val PEOPLE_STEP = 20
private const val DAY_STEP = 7

/** Daily notes: `memory/<date>/<agent>.md` grouped by day, newest first, 7 days at a time; the newest day opens. */
@Composable
fun DailyNotesList(onBack: () -> Unit) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    var days by remember { mutableStateOf<List<Pair<String, List<Pair<String, String>>>>?>(null) }
    var open by remember { mutableStateOf(emptySet<String>()) }
    var limit by remember { mutableIntStateOf(DAY_STEP) }
    LaunchedEffect(state.homeRevision) {
        val parsed = runCatching {
            world.homeFiles("memory/").mapNotNull { f ->
                val path = f.path ?: return@mapNotNull null
                DailyNotes.parse(path)?.let { Triple(it.date, it.agentId, f.content.orEmpty().trim()) }
            }
        }.getOrDefault(emptyList())
        days = parsed.groupBy { it.first }
            .map { (date, notes) -> date to notes.map { it.second to it.third } }
            .sortedByDescending { it.first }
        if (open.isEmpty()) days?.firstOrNull()?.let { open = setOf(it.first) }
    }
    val list = days
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 8.dp)) {
        MemoryBar("Daily notes", onBack = onBack)
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (list != null && list.isEmpty()) item { Text("No daily notes yet.", style = junoText(TextSize.Base), color = c.fgMuted, modifier = Modifier.padding(vertical = 12.dp)) }
            list?.take(limit)?.forEach { (date, notes) ->
                val expanded = date in open
                item(key = date) {
                    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.tile)).background(c.tile).padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(
                            Modifier.fillMaxWidth().clickable { open = if (expanded) open - date else open + date },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(date, style = junoText(TextSize.Md, FontWeight.Medium), color = c.fg, modifier = Modifier.weight(1f))
                            Icon(if (expanded) JunoIcons.ChevronDown else JunoIcons.ChevronRight, contentDescription = null, tint = c.fgSubtle)
                        }
                        if (expanded) notes.forEach { (agentId, content) ->
                            Text(world.state.value.agent(agentId)?.name ?: agentId, style = junoText(TextSize.Xs, FontWeight.Medium), color = c.fgMuted)
                            Text(content, style = junoText(TextSize.Base), color = c.fg)
                        }
                    }
                }
            }
            item { ShowMore(shown = limit, total = list?.size ?: 0, onMore = { limit += DAY_STEP }) }
            item { Text("What each agent wrote down during the day. Read-only.", style = junoText(TextSize.Xs), color = c.fgSubtle, modifier = Modifier.padding(top = 12.dp)) }
        }
    }
}
