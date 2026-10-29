package io.github.nigelleong0703.juno.ui.chat

import io.github.nigelleong0703.juno.ui.components.Hairline
import io.github.nigelleong0703.juno.ui.components.JunoIcons
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Item
import io.github.nigelleong0703.juno.contract.Todo
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/**
 * A `plan` item (iOS `PlanCard`): the title with "N remaining" (or "Done ⌄" once all is done, tap to open), the active
 * todos and up to three pending ones with their notes, a "N more" row, and a 2dp progress line.
 */
@Composable
fun PlanCard(item: Item, runTitle: String?) {
    val c = JunoTheme.colors
    val todos = item.todos.orEmpty()
    val done = todos.count { it.status == "done" }
    val allDone = todos.isNotEmpty() && done == todos.size
    var expanded by remember { mutableStateOf(false) }
    val active = todos.filter { it.status == "in_progress" || it.status == "blocked" }
    val pending = todos.filter { it.status == "pending" }
    // iOS: the preview is the first three open rows; "more" counts every todo that is not shown.
    val preview = (active + pending).take(RUNNING_ROWS)
    val rows = if (expanded) todos else if (allDone) emptyList() else preview
    val hidden = todos.size - preview.size
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.xl)).background(c.card).border(1.dp, c.border, RoundedCornerShape(Radius.xl)),
    ) {
        Row(
            Modifier.fillMaxWidth().clickable(enabled = allDone) { expanded = !expanded }.padding(horizontal = 12.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(runTitle ?: item.title ?: "Plan", color = c.fg, style = junoText(TextSize.Sm, FontWeight.Medium), modifier = Modifier.weight(1f))
            if (allDone) Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(JunoIcons.Check, null, tint = JunoStatus.success, modifier = Modifier.size(10.dp))
                Text("Done", color = c.fgSubtle, style = junoText(TextSize.Xs))
                Icon(JunoIcons.ChevronDown, null, tint = c.fgSubtle, modifier = Modifier.size(9.dp).rotate(if (expanded) 180f else 0f))
            } else Text("${todos.size - done} remaining", color = c.fgSubtle, style = junoText(TextSize.Xs))
        }
        rows.forEach { todo ->
            Hairline()
            Box(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) { TodoRow(todo) }
        }
        if (!allDone && hidden > 0) {
            Hairline()
            Text(
                if (expanded) "Show less" else "$hidden more", color = c.fgMuted, style = junoText(TextSize.Xs),
                modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded }.padding(horizontal = 12.dp, vertical = 8.dp),
            )
        }
        // iOS: a 2pt track (bgSubtle) with the done share in fgSubtle.
        Box(Modifier.fillMaxWidth().height(2.dp).background(c.bgSubtle)) {
            Box(Modifier.fillMaxWidth(done.toFloat() / maxOf(todos.size, 1)).height(2.dp).background(c.fgSubtle))
        }
    }
}

private const val RUNNING_ROWS = 3

/** One todo: a 16pt mark (check, spinner, warning, or an empty box for pending), its text and an optional note. */
@Composable
private fun TodoRow(todo: Todo) {
    val c = JunoTheme.colors
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
        Box(
            Modifier.padding(top = 2.dp).size(16.dp)
                .let { if (todo.status == "pending") it.border(1.dp, c.border, RoundedCornerShape(Radius.sm / 2)) else it },
            contentAlignment = Alignment.Center,
        ) {
            when (todo.status) {
                "done" -> Icon(JunoIcons.Check, null, tint = JunoStatus.success, modifier = Modifier.size(10.dp))
                "in_progress" -> CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp, color = c.fgMuted)
                "blocked" -> Icon(JunoIcons.Warning, null, tint = JunoStatus.warning, modifier = Modifier.size(10.dp))
            }
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                todo.text.orEmpty(), color = if (todo.status == "done") c.fgMuted else c.fg, style = junoText(TextSize.Sm),
                textDecoration = if (todo.status == "done") TextDecoration.LineThrough else null,
            )
            todo.note?.takeIf { it.isNotEmpty() }?.let { Text(it, color = c.fgMuted, style = junoText(TextSize.Xs)) }
        }
    }
}
