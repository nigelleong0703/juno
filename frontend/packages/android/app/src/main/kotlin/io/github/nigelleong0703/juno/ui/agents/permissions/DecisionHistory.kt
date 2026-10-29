package io.github.nigelleong0703.juno.ui.agents.permissions

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.background
import io.github.nigelleong0703.juno.ui.components.EmptyLine
import io.github.nigelleong0703.juno.ui.components.ShowMore
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Request
import io.github.nigelleong0703.juno.state.DecisionWords
import io.github.nigelleong0703.juno.state.Fmt
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.agentsData
import io.github.nigelleong0703.juno.state.loadDecided
import io.github.nigelleong0703.juno.state.sentence
import io.github.nigelleong0703.juno.ui.agents.TabHeader
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** The pure part of the history list: filter, split off "allowed by your rules" and cap (spec 2.18). */
data class HistoryView(val auto: List<Request>, val rest: List<Request>)

fun historyView(all: List<Request>, category: String?, outcome: String?): HistoryView {
    val filtered = all.filter { (category == null || it.payload?.brief?.categories?.contains(category) == true) && (outcome == null || it.outcome == outcome) }
    // Allowed by a rule is noise: one group row, unless that is the very outcome being looked at.
    return if (outcome == null) HistoryView(filtered.filter { it.outcome == "allowed_rule" }, filtered.filter { it.outcome != "allowed_rule" }) else HistoryView(emptyList(), filtered)
}

/** Decided requests with Kind and Result filters, an "N allowed by your rules" group, 8 at a time (spec 2.18). Does not update live. */
@Composable
fun DecisionHistory(agentId: String) {
    val world = LocalWorld.current
    val data by world.agentsData.collectAsState()
    var limit by remember { mutableIntStateOf(8) }
    var category by remember { mutableStateOf<String?>(null) }
    var outcome by remember { mutableStateOf<String?>(null) }
    var autoOpen by remember { mutableStateOf(false) }
    var autoLimit by remember { mutableIntStateOf(5) }
    val decided = data.decided[agentId]
    val all = decided?.items.orEmpty()
    val view = historyView(all, category, outcome)
    val more = view.rest.size > limit || decided?.next != null

    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        TabHeader("History")
        val kinds = (DecisionWords.delegable + DecisionWords.alwaysAsk).filter { k -> all.any { it.payload?.brief?.categories?.contains(k) == true } }
        val outcomes = DecisionWords.outcomes.filter { o -> all.any { it.outcome == o } }
        if (kinds.size > 1 || outcomes.size > 1) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (kinds.size > 1) FilterMenu("Kind", kinds.map { it to DecisionWords.badge(it) }, category) { category = it }
            if (outcomes.size > 1) FilterMenu("Result", outcomes.map { it to (DecisionWords.outcome(it) ?: it) }, outcome) { outcome = it }
        }
        if (all.isEmpty()) EmptyLine("No decisions yet.") else if (view.auto.isEmpty() && view.rest.isEmpty()) EmptyLine("Nothing matches.")
        if (view.auto.isNotEmpty()) AutoGroup(view.auto, autoOpen, autoLimit, { autoOpen = !autoOpen }, { autoLimit += 5 })
        view.rest.take(limit).forEach { HistoryRow(it) }
        if (more) ShowMore(limit, Int.MAX_VALUE, { limit += 8; if (view.rest.size < limit) world.loadDecided(agentId, more = true) })
    }
}

@Composable
private fun AutoGroup(rows: List<Request>, open: Boolean, limit: Int, onToggle: () -> Unit, onMore: () -> Unit) {
    val c = JunoTheme.colors
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(22.dp)).background(c.muted).padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(Modifier.fillMaxWidth().clickable(onClick = onToggle), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(JunoIcons.Shield, null, tint = c.fgMuted, modifier = Modifier.size(24.dp))
            Text("${rows.size} allowed by your rules", style = junoText(TextSize.Base, FontWeight.SemiBold), color = c.fg, modifier = Modifier.weight(1f))
        }
        if (open) {
            rows.take(limit).forEach { HistoryRow(it) }
            ShowMore(minOf(limit, rows.size), rows.size, onMore)
        }
    }
}

@Composable
private fun FilterMenu(title: String, options: List<Pair<String, String>>, selection: String?, onSelect: (String?) -> Unit) {
    val c = JunoTheme.colors
    var open by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier.clip(CircleShape).background(c.muted).clickable { open = true }.padding(start = 12.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(options.firstOrNull { it.first == selection }?.second ?: title, style = junoText(TextSize.Sm, FontWeight.Medium), color = if (selection == null) c.fgMuted else c.fg)
            Icon(JunoIcons.ChevronDown, null, tint = c.fgMuted, modifier = Modifier.size(18.dp))
        }
        DropdownMenu(open, { open = false }, containerColor = c.card) {
            DropdownMenuItem(text = { Text("All") }, onClick = { onSelect(null); open = false })
            options.forEach { (id, label) -> DropdownMenuItem(text = { Text(label) }, onClick = { onSelect(id); open = false }) }
        }
    }
}

/** A decided request: the sentence, the outcome and when, the kind as a badge; tap to expand the reason. */
@Composable
private fun HistoryRow(request: Request) {
    val c = JunoTheme.colors
    var open by remember { mutableStateOf(false) }
    val brief = request.payload?.brief
    val primary = brief?.primary ?: brief?.categories?.firstOrNull()
    val warn = primary == "irreversible" || primary == "sensitive"
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.xl)).background(c.muted).clickable { open = !open }.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(request.sentence, style = junoText(TextSize.Base, FontWeight.SemiBold), color = c.fg, maxLines = if (open) Int.MAX_VALUE else 2, overflow = TextOverflow.Ellipsis)
                Text(listOfNotNull(DecisionWords.outcome(request.outcome) ?: Fmt.status(request.status), Fmt.ago(request.resolvedAt).takeIf { it.isNotEmpty() }).joinToString(" · "), style = junoText(TextSize.Xs), color = c.fgSubtle)
            }
            if (primary != null) Text(
                DecisionWords.badge(primary), style = junoText(TextSize.Xs, FontWeight.Medium), color = if (warn) JunoStatus.warning else c.fgMuted,
                modifier = Modifier.clip(CircleShape).background((if (warn) JunoStatus.warning else c.fgMuted).copy(alpha = 0.14f)).padding(horizontal = 8.dp, vertical = 3.dp),
            )
        }
        if (open) {
            brief?.why?.takeIf { it.isNotEmpty() }?.let { Text(it, style = junoText(TextSize.Sm), color = c.fgMuted) }
            brief?.ifDenied?.takeIf { it.isNotEmpty() }?.let { Text("If denied: $it", style = junoText(TextSize.Sm), color = c.fgMuted) }
        }
    }
}
