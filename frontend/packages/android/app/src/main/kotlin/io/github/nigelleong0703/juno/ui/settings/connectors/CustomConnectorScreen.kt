package io.github.nigelleong0703.juno.ui.settings.connectors

import io.github.nigelleong0703.juno.ui.components.GroupedPage
import io.github.nigelleong0703.juno.ui.components.GroupedSection
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Connection
import io.github.nigelleong0703.juno.state.ConnectorRules
import io.github.nigelleong0703.juno.state.World
import io.github.nigelleong0703.juno.state.disconnectConnection
import io.github.nigelleong0703.juno.state.setConnectionPermission
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.settings.SettingsError
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/**
 * A custom MCP server: its address, the permission once connected, Connect or Reconnect (browser sign-in), and
 * Disconnect (iOS `CustomConnectorView`). The server's own permission default is full (see [ConnectorRules]).
 */
@Composable
fun CustomConnectorScreen(connectionId: String, model: PluginsModel, onBack: () -> Unit) {
    val connections by model.connections.collectAsState()
    val connection = connections.firstOrNull { it.id == connectionId }
    val c = JunoTheme.colors
    val context = LocalContext.current
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun change(work: suspend (World) -> Unit) {
        busy = true
        error = null
        model.perform(work) { failure ->
            busy = false
            error = failure
        }
    }

    GroupedPage(title = connection?.name ?: "Connector", onBack = onBack) {
        error?.let { SettingsError(it) }
        if (connection != null) {
            val status = connection.status
            GroupedSection(footer = statusLine(status)) {
                Text(connection.endpoint.orEmpty(), style = junoText(TextSize.Sm), color = c.fgMuted, modifier = Modifier.padding(16.dp))
            }
            if (ConnectorRules.isConnected(status)) {
                val permission = ConnectorRules.customPermission(connection)
                GroupedSection(header = "What your agents can do", footer = permissionHelp(permission)) {
                    PermissionPicker(permission, enabled = !busy) { level ->
                        change { it.setConnectionPermission(connection.id, level) }
                    }
                }
            } else {
                JunoButton(
                    text = if (status == Connection.StatusValue.error) "Reconnect" else "Connect",
                    onClick = { change { it.authorizeWithBrowser(context, connection.id) } },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !busy,
                )
            }
            if (status != Connection.StatusValue.disconnected) {
                GroupedSection {
                    ActionRow("Disconnect", enabled = !busy, danger = true) {
                        change { it.disconnectConnection(connection.id) }
                    }
                }
            }
        }
    }
}

private fun statusLine(status: String?): String = when (status) {
    Connection.StatusValue.connected -> "Connected"
    Connection.StatusValue.error -> "Needs reconnecting"
    else -> "Not connected"
}
