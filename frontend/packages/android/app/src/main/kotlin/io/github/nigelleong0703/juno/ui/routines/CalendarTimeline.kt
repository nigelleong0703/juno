package io.github.nigelleong0703.juno.ui.routines

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.BorderStroke
import io.github.nigelleong0703.juno.ui.components.agentTint
import io.github.nigelleong0703.juno.ui.components.AgentAvatar
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.AgentCalendarItem
import io.github.nigelleong0703.juno.contract.Routine
import io.github.nigelleong0703.juno.state.Fmt
import io.github.nigelleong0703.juno.state.RoutineCalendar
import io.github.nigelleong0703.juno.state.RoutineCalendar.BLOCK_MINUTES
import io.github.nigelleong0703.juno.state.WorldState
import io.github.nigelleong0703.juno.state.needsSetup
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

private val HourHeight = 56.dp
private val Gutter = 44.dp
private const val OPEN_AT_HOUR = 7

/** 24 hour rows (opens scrolled to 07:00, again on day change), blocks in lanes, and a red now-line today (spec 2.23). */
@Composable
fun CalendarTimeline(
    state: WorldState, day: LocalDate, blocks: List<RoutineCalendar.Block>, onRoutine: (Routine) -> Unit, onItem: (AgentCalendarItem) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = JunoTheme.colors
    val zone = ZoneId.systemDefault()
    val scroll = rememberScrollState()
    val density = androidx.compose.ui.platform.LocalDensity.current
    LaunchedEffect(day) { scroll.scrollTo(with(density) { (HourHeight * OPEN_AT_HOUR).roundToPx() }) }
    val placed = RoutineCalendar.lanes(blocks, zone)

    Box(modifier.fillMaxSize().verticalScroll(scroll)) {
        Column {
            (0 until 24).forEach { hour ->
                Row(Modifier.fillMaxWidth().height(HourHeight), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        if (hour == 0) "" else "%02d:00".format(hour), style = junoText(TextSize.Xs), color = c.fgSubtle, textAlign = TextAlign.End,
                        modifier = Modifier.width(Gutter).offset(y = (-7).dp),
                    )
                    Box(Modifier.weight(1f).height(0.5.dp).background(c.border))
                }
            }
        }
        BoxWithConstraints(Modifier.fillMaxWidth().height(HourHeight * 24).padding(end = 8.dp)) {
            val width = maxWidth - Gutter - 14.dp
            placed.forEach { p ->
                val minutes = RoutineCalendar.minutesOfDay(p.block.start, zone)
                Box(
                    Modifier.offset(x = Gutter + 6.dp + width / p.lanes * p.lane, y = HourHeight * minutes / 60)
                        .size(width / p.lanes - 2.dp, HourHeight * BLOCK_MINUTES / 60 - 2.dp),
                ) {
                    p.block.occurrence?.let { RoutineBlock(state, it, onRoutine) }
                    p.block.item?.let { ItemBlock(state, it, onItem) }
                }
            }
            if (day == LocalDate.now()) {
                Box(Modifier.padding(start = Gutter).offset(y = HourHeight * RoutineCalendar.minutesOfDay(Instant.now(), zone) / 60).fillMaxWidth().height(1.dp).background(JunoStatus.danger))
            }
        }
    }
}

@Composable
private fun RoutineBlock(state: WorldState, o: RoutineCalendar.Occurrence, onClick: (Routine) -> Unit) {
    val c = JunoTheme.colors
    val r = o.routine
    val agent = state.agent(r.agentId)
    val tint = agentTint(agent)
    val dimmed = !o.past && (r.enabled == false || r.status == "paused" || r.needsSetup || r.status == "error")
    val failed = o.past && o.status == "failed"
    val shape = RoundedCornerShape(6.dp)
    Column(
        Modifier.fillMaxSize().alpha(if (dimmed) 0.5f else 1f).clip(shape).background(tint.copy(alpha = if (o.past) 0.4f else 0.18f))
            .then(if (failed) Modifier.border(1.5.dp, JunoStatus.danger, shape) else Modifier)
            .drawBehind { drawRect(tint, size = androidx.compose.ui.geometry.Size(3.dp.toPx(), size.height)) }
            .clickable { onClick(r) }.padding(horizontal = 6.dp, vertical = 3.dp),
        verticalArrangement = Arrangement.spacedBy(1.dp),
    ) {
        Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            AgentAvatar(agent, 16.dp)
            Text(r.name.orEmpty(), style = junoText(TextSize.Sm, FontWeight.SemiBold), color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            if (o.past && o.status == "completed") Icon(JunoIcons.Check, null, tint = c.fg, modifier = Modifier.size(10.dp))
            if (failed) Icon(JunoIcons.Alert, null, tint = JunoStatus.danger, modifier = Modifier.size(11.dp))
        }
        Text(Fmt.time(o.start.toString()), style = junoText(TextSize.Xs), color = c.fgMuted)
    }
}

private fun kindIcon(kind: String?): ImageVector = when (kind) { "meeting" -> JunoIcons.Video; "task" -> JunoIcons.CheckSquare; else -> JunoIcons.Profile }

/** An item from the agent's own calendar: dashed agent-tinted outline (solid amber when missed), kind icon, title (spec 2.23). */
@Composable
private fun ItemBlock(state: WorldState, item: AgentCalendarItem, onClick: (AgentCalendarItem) -> Unit) {
    val c = JunoTheme.colors
    val tint = agentTint(state.agent(item.agentId))
    val missed = item.status == "missed"
    val outline = if (missed) JunoStatus.warning else tint
    Column(
        Modifier.fillMaxSize().clip(RoundedCornerShape(6.dp)).background(tint.copy(alpha = if (item.status == "done") 0.3f else 0.12f))
            .drawBehind {
                drawRoundRect(outline, cornerRadius = androidx.compose.ui.geometry.CornerRadius(6.dp.toPx()), style = Stroke(1.5.dp.toPx(), pathEffect = if (missed) null else PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx()))))
            }
            .clickable { onClick(item) }.padding(horizontal = 6.dp, vertical = 3.dp),
        verticalArrangement = Arrangement.spacedBy(1.dp),
    ) {
        Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Icon(kindIcon(item.kind), null, tint = c.fg, modifier = Modifier.size(11.dp))
            Text(item.title.orEmpty(), style = junoText(TextSize.Sm, FontWeight.SemiBold), color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            if (item.status == "done") Icon(JunoIcons.Check, null, tint = c.fg, modifier = Modifier.size(10.dp))
        }
        Text(if (missed) "Missed" else Fmt.time(item.at), style = junoText(TextSize.Xs), color = c.fgMuted)
    }
}
