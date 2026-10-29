package io.github.nigelleong0703.juno.ui.shell

import io.github.nigelleong0703.juno.ui.components.GroupedSection
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/**
 * One agent row (iOS `AgentRow`): the avatar (or stacked figures), the name, and a line under it: the role, else what
 * the agent is doing. [trailing] is the selection mark in the picker. Rows sit inside a `GroupedSection`, so the
 * hairline closes each one.
 */
@Composable
fun AgentRow(
    avatar: @Composable () -> Unit,
    title: String,
    subtitle: String?,
    onClick: () -> Unit,
    trailing: @Composable (() -> Unit)? = null,
) {
    val c = JunoTheme.colors
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            avatar()
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(title, style = junoText(TextSize.Md, FontWeight.Medium), color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                subtitle?.let { Text(it, style = junoText(TextSize.Sm), color = c.fgMuted, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
            trailing?.let { Spacer(Modifier.width(12.dp)); it() }
        }
        HorizontalDivider(color = c.border)
    }
}
