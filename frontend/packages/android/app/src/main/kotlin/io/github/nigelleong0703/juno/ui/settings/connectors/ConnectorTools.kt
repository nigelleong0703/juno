package io.github.nigelleong0703.juno.ui.settings.connectors

import io.github.nigelleong0703.juno.ui.components.GroupedSection
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.state.ConnectorToolView
import io.github.nigelleong0703.juno.ui.settings.ShowMoreButton
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

private const val TOOL_CAP = 8

/** The tools a connected connector gives the agents: monospace name, description, Read or Action. Capped at 8. */
@Composable
fun ConnectorToolsGroup(tools: List<ConnectorToolView>?, showAll: Boolean, onShowAll: () -> Unit) {
    GroupedSection(header = "Tools") {
        if (tools == null) {
            LoadingLine()
            return@GroupedSection
        }
        val shown = if (showAll) tools else tools.take(TOOL_CAP)
        shown.forEach { ToolRow(it) }
        if (!showAll && tools.size > TOOL_CAP) ShowMoreButton("Show all ${tools.size}", onShowAll)
    }
}

@Composable
private fun ToolRow(tool: ConnectorToolView) {
    val c = JunoTheme.colors
    val read = tool.kind == "read"
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp)) {
            Column(Modifier.weight(1f)) {
                Text(
                    tool.name.orEmpty(),
                    style = junoText(TextSize.Sm).copy(fontFamily = FontFamily.Monospace),
                    color = c.fg,
                )
                Text(
                    tool.description.orEmpty(), style = junoText(TextSize.Xs), color = c.fgSubtle,
                    maxLines = 2, overflow = TextOverflow.Ellipsis,
                )
            }
            Spacer(Modifier.width(8.dp))
            Text(
                if (read) "Read" else "Action", style = junoText(TextSize.Xxs),
                color = if (read) c.fgMuted else JunoStatus.warning,
            )
        }
        HorizontalDivider(color = c.border)
    }
}
