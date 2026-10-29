package io.github.nigelleong0703.juno.ui.settings.connectors

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import coil3.compose.AsyncImage
import io.github.nigelleong0703.juno.ui.components.BrandIcon
import io.github.nigelleong0703.juno.ui.components.JunoAccentBlue
import io.github.nigelleong0703.juno.state.ConnectorRules
import io.github.nigelleong0703.juno.state.ConnectorView
import io.github.nigelleong0703.juno.ui.components.BrandIcon
import io.github.nigelleong0703.juno.ui.components.GroupedRow
import io.github.nigelleong0703.juno.ui.components.RowMarker
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.SystemText

/** The category glyph of a connector: the fallback under its brand logo ([BrandIcon]). */
internal fun connectorIcon(name: String?): ImageVector = when (name) {
    "mail" -> JunoIcons.Mail
    "calendar" -> JunoIcons.Calendar
    "folder" -> JunoIcons.Library
    "doc" -> JunoIcons.File
    "table" -> JunoIcons.Table
    "notebook" -> JunoIcons.Book
    "issues" -> JunoIcons.Target
    "tasks" -> JunoIcons.Checklist
    "jira" -> JunoIcons.Grid
    "payments" -> JunoIcons.CreditCard
    "automation" -> JunoIcons.Zap
    "contacts" -> JunoIcons.Profile
    "map" -> JunoIcons.Map
    "video" -> JunoIcons.Video
    "music" -> JunoIcons.Music
    else -> JunoIcons.Plugins
}

/** Connected (check) or Reconnect (warning); nothing for a connector that was never connected. */
@Composable
fun ConnectorStatusLabel(status: String?) {
    when {
        ConnectorRules.isConnected(status) -> Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(JunoIcons.Check, contentDescription = null, tint = JunoStatus.success, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(4.dp))
            Text("Connected", style = SystemText.footnote, color = JunoStatus.success)
        }
        ConnectorRules.needsReconnect(status) -> Text("Reconnect", style = SystemText.footnote, color = JunoStatus.warning)
        else -> {}
    }
}

/**
 * One catalog connector (Muse connectors list): a 40 dp brand logo, name and description. A connected one ends with ›;
 * an available one ends with a blue "Connect" text action. Both open the connector's detail page.
 */
@Composable
fun ConnectorRow(connector: ConnectorView, onClick: () -> Unit) {
    val connected = ConnectorRules.isConnected(connector.status)
    val reconnect = ConnectorRules.needsReconnect(connector.status)
    GroupedRow(
        title = connector.name.orEmpty(),
        subtitle = connector.description,
        marker = if (connected) RowMarker.Chevron else RowMarker.None,
        leading = { BrandIcon(connector.id, connectorIcon(connector.icon), size = 40.dp, logoScale = 0.8f) },
        extra = if (reconnect) ({ Text("Reconnect", style = SystemText.footnote, color = JunoStatus.warning) }) else null,
        trailing = if (connected || reconnect) null else ({
            Text("Connect", style = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.Medium), color = JunoAccentBlue)
        }),
        onClick = onClick,
    )
}

/** The centred spinner of a list still loading. */
@Composable
fun LoadingLine() {
    Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp, color = JunoTheme.colors.fgMuted)
    }
}

/** A text action inside a grouped section: destructive text in the danger colour. */
@Composable
fun ActionRow(title: String, enabled: Boolean = true, danger: Boolean = false, onClick: () -> Unit) {
    val c = JunoTheme.colors
    Text(
        title, style = SystemText.body,
        color = when {
            !enabled -> c.fgSubtle
            danger -> JunoStatus.danger
            else -> c.fg
        },
        modifier = Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp),
    )
}
