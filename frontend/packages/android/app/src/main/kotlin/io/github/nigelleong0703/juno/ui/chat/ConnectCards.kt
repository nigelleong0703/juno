package io.github.nigelleong0703.juno.ui.chat

import io.github.nigelleong0703.juno.ui.components.BrandIcon
import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.ConnectorView
import io.github.nigelleong0703.juno.state.loadConnectorCatalog
import io.github.nigelleong0703.juno.ui.components.ShowMore
import io.github.nigelleong0703.juno.ui.settings.connectors.ConnectButton
import io.github.nigelleong0703.juno.ui.settings.connectors.connectorIcon
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/*
 * The apps a `connect` request offers (iOS RequestCards.swift `ConnectOffer` and the routine branch of `connect`). Each app
 * is a catalog connector; a Connect button starts its sign-in through [ConnectButton].
 */

/** The offer an agent makes in chat (no routine): a light list, four rows then "Show more", a Connect pill on each app. */
@Composable
fun ConnectOffer(title: String, catalogIds: List<String>) {
    val c = JunoTheme.colors
    val catalog = rememberConnectCatalog()
    val apps = connectorsFor(catalogIds, catalog.value)
    var expanded by remember { mutableStateOf(false) }
    val shown = if (expanded) apps else apps.take(CAP)
    CardSurface {
        Text(title, color = c.fg, style = junoText(TextSize.Base, FontWeight.Medium))
        shown.forEach { ConnectRow(it, onConnected = catalog.reload) }
        if (!expanded) ShowMore(shown.size, apps.size, onMore = { expanded = true }, label = "Show ${apps.size - shown.size} more")
    }
}

/** A routine can't run until one of its apps is connected: a full-width Connect button per app. */
@Composable
fun ConnectRoutineApps(catalogIds: List<String>) {
    val catalog = rememberConnectCatalog()
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        connectorsFor(catalogIds, catalog.value).forEach { ConnectButton(it, large = true, onConnected = catalog.reload) }
    }
}

@Composable
private fun ConnectRow(connector: ConnectorView, onConnected: () -> Unit) {
    val c = JunoTheme.colors
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        BrandIcon(connector.id, connectorIcon(connector.icon), 32.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(connector.name, color = c.fg, style = junoText(TextSize.Base, FontWeight.Medium), maxLines = 1, overflow = TextOverflow.Ellipsis)
            connector.description.takeIf { it.isNotEmpty() }?.let {
                Text(it, color = c.fgMuted, style = junoText(TextSize.Sm), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (connector.status == "connected") {
            Icon(JunoIcons.Check, contentDescription = null, tint = c.fgMuted, modifier = Modifier.size(16.dp))
            Spacer(Modifier.size(4.dp))
            Text("Connected", color = c.fgMuted, style = junoText(TextSize.Sm))
        } else {
            ConnectButton(connector, label = "Connect", onConnected = onConnected)
        }
    }
}

private const val CAP = 4

/** The apps in the order the request lists them. A listed id the catalog lacks still shows, with its id as the name. The Mac is not a connector and is left out. */
private fun connectorsFor(catalogIds: List<String>, catalog: List<ConnectorView>?): List<ConnectorView> =
    catalogIds.filter { it != "mac" }.map { id -> catalog?.firstOrNull { it.id == id }
        ?: ConnectorView(id, id, "", null, id, "featured", true, "read_only", "disconnected") }

/** The connector catalog, loaded once per card and reloaded after a connect so the rows show their new status. */
private class ConnectCatalog(val value: List<ConnectorView>?, val reload: () -> Unit)

@Composable
private fun rememberConnectCatalog(): ConnectCatalog {
    val world = LocalWorld.current
    var version by remember { mutableIntStateOf(0) }
    val state: State<List<ConnectorView>?> = produceState<List<ConnectorView>?>(null, version) {
        value = try {
            world.loadConnectorCatalog()
        } catch (e: Throwable) {
            if (e.isCancellation) throw e
            null
        }
    }
    return ConnectCatalog(state.value) { version++ }
}
