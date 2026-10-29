package io.github.nigelleong0703.juno.ui.routines

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.background
import io.github.nigelleong0703.juno.ui.components.ShowMore
import io.github.nigelleong0703.juno.ui.components.agentTint
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.AgentCalendarItem
import io.github.nigelleong0703.juno.contract.Routine
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.RoutineCalendar
import io.github.nigelleong0703.juno.state.agentsData
import io.github.nigelleong0703.juno.state.loadCalendar
import io.github.nigelleong0703.juno.state.loadRoutines
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.SystemText
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale

/** One day at a time: week strip, frequent-routine chips, 24-hour timeline, and the on-demand routines (spec 2.23). */
@Composable
fun CalendarScreen() {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val data by world.agentsData.collectAsState()
    val c = JunoTheme.colors
    val zone = ZoneId.systemDefault()
    var day by remember { mutableStateOf(LocalDate.now()) }
    var opened by remember { mutableStateOf<Routine?>(null) }
    var openedItem by remember { mutableStateOf<AgentCalendarItem?>(null) }
    var onDemandLimit by remember { mutableIntStateOf(3) }
    val from = day.atStartOfDay(zone).toInstant()
    val to = day.plusDays(1).atStartOfDay(zone).toInstant()
    LaunchedEffect(Unit) { world.loadRoutines() }
    // The calendar is not live: refetched when the day changes, cancel is local plus DELETE.
    LaunchedEffect(day) { world.loadCalendar(from, to) }

    val routines = data.routines.filter { state.scope == null || it.agentId == state.scope }
    val items = RoutineCalendar.dayItems(data.calendar, from, to, state.scope)
    val blocks = RoutineCalendar.blocks(RoutineCalendar.occurrences(routines, from, to), items)
    val dense = RoutineCalendar.dense(routines, from, to)
    val onDemand = routines.filter { !RoutineCalendar.isTimed(it) }
    val hasTimed = routines.any(RoutineCalendar::isTimed)

    Column(Modifier.fillMaxSize().background(c.canvas)) {
        WeekStrip(day, { day = it })
        if (!hasTimed && items.isEmpty()) {
            Column(Modifier.weight(1f).fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Icon(JunoIcons.Calendar, null, tint = c.fgSubtle, modifier = Modifier.size(36.dp))
                Text("No scheduled automations", style = SystemText.headline, color = c.fg, textAlign = TextAlign.Center)
                Text("Scheduled routines appear here, one colour per agent.", style = SystemText.subheadline, color = c.fgMuted, textAlign = TextAlign.Center)
            }
        } else {
            if (dense.isNotEmpty()) Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                dense.forEach { r ->
                    Text(
                        "${r.name.orEmpty()} · Hourly", style = junoText(TextSize.Sm, FontWeight.Medium), color = c.fg, maxLines = 1,
                        modifier = Modifier.clip(CircleShape).background(agentTint(state.agent(r.agentId)).copy(alpha = 0.28f)).clickable { opened = r }.padding(horizontal = 10.dp, vertical = 5.dp),
                    )
                }
            }
            CalendarTimeline(state, day, blocks, { opened = it }, { openedItem = it }, Modifier.weight(1f))
        }
        if (onDemand.isNotEmpty()) OnDemand(state.agents, onDemand, onDemandLimit, { onDemandLimit += 6 }) { opened = it }
    }
    opened?.let { RoutineSheet(it.id) { opened = null } }
    openedItem?.let { CalendarItemSheet(it.id, it) { openedItem = null } }
}

/** "<Month Year>", Today, previous/next week and seven day buttons, Monday first (spec 2.23). */
@Composable
private fun WeekStrip(day: LocalDate, onPick: (LocalDate) -> Unit) {
    val c = JunoTheme.colors
    val today = LocalDate.now()
    val monday = day.with(DayOfWeek.MONDAY)
    Column(Modifier.padding(bottom = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(day.format(DateTimeFormatter.ofPattern("LLLL yyyy", Locale.getDefault())), style = junoText(TextSize.Lg, FontWeight.SemiBold), color = c.fg, modifier = Modifier.weight(1f))
            TextButton({ onPick(today) }, enabled = day != today) { Text("Today", style = junoText(TextSize.Base, FontWeight.Medium), color = if (day != today) c.fg else c.fgSubtle) }
        }
        Row(Modifier.padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton({ onPick(day.minusDays(7)) }, Modifier.size(width = 28.dp, height = 44.dp)) { Icon(JunoIcons.ChevronLeft, "Previous week", tint = c.fgMuted) }
            (0 until 7).forEach { offset ->
                val date = monday.plusDays(offset.toLong())
                val selected = date == day
                Column(Modifier.weight(1f).clickable { onPick(date) }, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(date.dayOfWeek.getDisplayName(TextStyle.NARROW, Locale.getDefault()), style = junoText(TextSize.Xs), color = c.fgMuted)
                    Box(Modifier.size(32.dp).clip(CircleShape).background(if (selected) c.primary else c.canvas), contentAlignment = Alignment.Center) {
                        Text(date.dayOfMonth.toString(), style = junoText(TextSize.Base, FontWeight.SemiBold), color = if (selected) c.primaryFg else if (date == today) JunoStatus.danger else c.fg)
                    }
                }
            }
            IconButton({ onPick(day.plusDays(7)) }, Modifier.size(width = 28.dp, height = 44.dp)) { Icon(JunoIcons.ChevronRight, "Next week", tint = c.fgMuted) }
        }
    }
}

/** Routines that are not timed: up to 3, "Show more" +6, the area capped at 150dp (spec 2.23). */
@Composable
private fun OnDemand(agents: List<io.github.nigelleong0703.juno.contract.Agent>, list: List<Routine>, limit: Int, onMore: () -> Unit, onOpen: (Routine) -> Unit) {
    val c = JunoTheme.colors
    Column(Modifier.fillMaxWidth().background(c.bgSubtle).padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("On demand", style = junoText(TextSize.Sm, FontWeight.SemiBold), color = c.fgMuted)
        Column(Modifier.heightIn(max = 150.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            list.take(limit).forEach { r ->
                Row(Modifier.fillMaxWidth().clickable { onOpen(r) }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.size(8.dp).clip(CircleShape).background(agentTint(agents.firstOrNull { it.id == r.agentId })))
                    Text(r.name.orEmpty(), style = junoText(TextSize.Base, FontWeight.Medium), color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(r.trigger?.human.orEmpty(), style = junoText(TextSize.Sm), color = c.fgSubtle, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            ShowMore(minOf(limit, list.size), list.size, onMore)
        }
    }
}
