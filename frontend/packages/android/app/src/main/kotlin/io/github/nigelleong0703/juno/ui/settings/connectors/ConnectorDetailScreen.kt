package io.github.nigelleong0703.juno.ui.settings.connectors

import io.github.nigelleong0703.juno.ui.components.BrandIcon
import io.github.nigelleong0703.juno.ui.components.GroupedPage
import io.github.nigelleong0703.juno.ui.components.GroupedSection
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.state.ConnectorRules
import io.github.nigelleong0703.juno.state.ConnectorToolView
import io.github.nigelleong0703.juno.state.ConnectorView
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.World
import io.github.nigelleong0703.juno.state.connectorTools
import io.github.nigelleong0703.juno.state.disconnectConnector
import io.github.nigelleong0703.juno.state.setConnectionPermission
import io.github.nigelleong0703.juno.ui.settings.SettingsError
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/**
 * One catalog connector: its permission (once a connection exists), its tools when connected, Connect or Reconnect,
 * and Disconnect behind a confirm (iOS `ConnectorDetailView`).
 */
@Composable
fun ConnectorDetailScreen(connector: ConnectorView, model: PluginsModel, onBack: () -> Unit) {
    val world = LocalWorld.current
    val c = JunoTheme.colors
    val connected = ConnectorRules.isConnected(connector.status)
    val permission = ConnectorRules.catalogPermission(connector)
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var disconnecting by remember { mutableStateOf(false) }
    var tools by remember { mutableStateOf<List<ConnectorToolView>?>(null) }
    var allTools by remember { mutableStateOf(false) }

    LaunchedEffect(connector.id, connected) {
        tools = null
        tools = if (connected) loadTools(world, connector.id) else emptyList()
    }

    fun change(work: suspend (World) -> Unit) {
        busy = true
        error = null
        model.perform(work) { failure ->
            busy = false
            error = failure
        }
    }

    GroupedPage(title = connector.name ?: "Connector", onBack = onBack) {
        error?.let { SettingsError(it) }
        GroupedSection {
            Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                BrandIcon(connector.id, connectorIcon(connector.icon), 32.dp)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(connector.name.orEmpty(), style = junoText(TextSize.Md, FontWeight.Medium), color = c.fg)
                    connector.description?.let { Text(it, style = junoText(TextSize.Sm), color = c.fgMuted) }
                }
                Spacer(Modifier.width(8.dp))
                ConnectorStatusLabel(connector.status)
            }
        }
        if (connector.available == false) {
            Text("Not set up on this server.", style = junoText(TextSize.Sm), color = JunoStatus.warning)
        }
        connector.connectionId?.let { connectionId ->
            GroupedSection(header = "What your agents can do", footer = permissionHelp(permission)) {
                PermissionPicker(permission, enabled = !busy) { level ->
                    change { it.setConnectionPermission(connectionId, level) }
                }
            }
        }
        if (connected) ConnectorToolsGroup(tools, allTools) { allTools = true }
        if (!connected) {
            ConnectButton(
                connector,
                large = true,
                label = if (connector.status == "disconnected") "Connect" else "Reconnect",
                onError = { error = it },
            )
        }
        if (connector.status != "disconnected") {
            GroupedSection {
                ActionRow("Disconnect", enabled = !busy, danger = true) { disconnecting = true }
            }
        }
    }

    if (disconnecting) {
        AlertDialog(
            onDismissRequest = { disconnecting = false },
            containerColor = c.card,
            titleContentColor = c.fg,
            textContentColor = c.fgMuted,
            title = { Text("Disconnect ${connector.name.orEmpty()}?", style = junoText(TextSize.Lg, FontWeight.SemiBold)) },
            text = {
                Text(
                    "Your agents lose its tools, and the sign-in is revoked where the service supports it.",
                    style = junoText(TextSize.Sm),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    disconnecting = false
                    change { it.disconnectConnector(connector.id) }
                }) { Text("Disconnect", color = JunoStatus.danger) }
            },
            dismissButton = { TextButton(onClick = { disconnecting = false }) { Text("Cancel", color = c.fg) } },
        )
    }
}

/** The tool list is advisory: a read that fails shows no tools rather than an error (iOS `try?`). */
private suspend fun loadTools(world: World, id: String): List<ConnectorToolView> = try {
    world.connectorTools(id)
} catch (e: Throwable) {
    if (e.isCancellation) throw e
    emptyList()
}
