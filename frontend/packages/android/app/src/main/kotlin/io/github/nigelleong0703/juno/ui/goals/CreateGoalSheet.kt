package io.github.nigelleong0703.juno.ui.goals

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.background
import io.github.nigelleong0703.juno.ui.components.FormField
import io.github.nigelleong0703.juno.ui.components.FormTextField
import io.github.nigelleong0703.juno.ui.components.JunoSheet
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.state.Fmt
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.createGoal
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** The seven categories POST /v1/goals accepts. */
val GoalCategories = listOf("health", "relationships", "finance", "career", "interests", "productivity", "other")

/** "New goal": kind, title, where it stands, category and the tracking agent (spec 2.20). Create is optimistic. */
@Composable
fun CreateGoalSheet(onDismiss: () -> Unit) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    var kind by remember { mutableStateOf("goal") }
    var title by remember { mutableStateOf("") }
    var summary by remember { mutableStateOf("") }
    var category by remember { mutableStateOf("other") }
    var agentId by remember { mutableStateOf(state.scope ?: state.agents.firstOrNull()?.id) }
    val ready = title.isNotBlank() && agentId != null

    JunoSheet("New goal", onDismiss, long = true, primary = "Create", primaryEnabled = ready, onPrimary = {
        agentId?.let { world.createGoal(it, kind, title.trim(), summary.trim(), category) }
        onDismiss()
    }) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Text(if (kind == "goal") "A longer aim the agent works on in steps." else "A concrete watch, such as a date or a price.", style = junoText(TextSize.Base), color = JunoTheme.colors.fgMuted)
            FormField("Kind") { Segmented(listOf("goal" to "Goal", "tracking" to "Tracking"), kind) { kind = it } }
            FormField("Title") { FormTextField(title, { title = it }, "Title") }
            FormField("Where it stands", optional = true) { FormTextField(summary, { summary = it }, "Where it stands", minLines = 1, maxLines = 5) }
            FormField("Category") { PickerRow(Fmt.capitalized(category), GoalCategories.map { it to Fmt.capitalized(it) }) { category = it } }
            FormField("Agent") { PickerRow(state.agent(agentId)?.name.orEmpty(), state.agents.map { it.id to it.name.orEmpty() }) { agentId = it } }
        }
    }
}

@Composable
private fun Segmented(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    val c = JunoTheme.colors
    Row(Modifier.fillMaxWidth().height(40.dp).clip(RoundedCornerShape(10.dp)).background(c.muted).padding(2.dp)) {
        options.forEach { (id, label) ->
            Box(Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(8.dp)).background(if (id == selected) c.card else c.muted).clickable { onSelect(id) }, contentAlignment = Alignment.Center) {
                Text(label, style = junoText(TextSize.Base, FontWeight.Medium), color = if (id == selected) c.fg else c.fgMuted)
            }
        }
    }
}

@Composable
private fun PickerRow(value: String, options: List<Pair<String, String>>, onSelect: (String) -> Unit) {
    val c = JunoTheme.colors
    var open by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.lg)).background(c.inputBg).clickable { open = true }.padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(value, style = junoText(TextSize.Lg), color = c.fg, modifier = Modifier.weight(1f))
            Icon(JunoIcons.ChevronDown, null, tint = c.fgMuted)
        }
        DropdownMenu(open, { open = false }, containerColor = c.card) {
            options.forEach { (id, label) -> DropdownMenuItem(text = { Text(label) }, onClick = { open = false; onSelect(id) }) }
        }
    }
}
