package io.github.nigelleong0703.juno.ui.settings.connectors

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import io.github.nigelleong0703.juno.state.ConnectorView
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.reportSyncError
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.settings.SettingsPill
import kotlinx.coroutines.launch

/**
 * "Connect <app>" for one catalog connector, used beside a feature that needs it (iOS `ConnectButton`). An API-key
 * connector opens its key sheet; any other starts the sign-in in the browser. Cancelling is not an error.
 *
 * [label] replaces "Connect <name>" where the app is already named beside the button. [large] is the full-width card
 * button; otherwise the compact pill. A failure goes to [onError], or to the world's sync error when none is given.
 */
@Composable
fun ConnectButton(
    connector: ConnectorView,
    modifier: Modifier = Modifier,
    label: String? = null,
    large: Boolean = false,
    onError: ((String) -> Unit)? = null,
    onConnected: () -> Unit = {},
) {
    val world = LocalWorld.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var keySheet by remember { mutableStateOf(false) }
    val title = label ?: "Connect ${connector.name ?: connector.id}"
    val enabled = !busy && connector.available != false

    fun start() {
        if (connector.apiKey) {
            keySheet = true
            return
        }
        busy = true
        scope.launch {
            try {
                world.connectWithBrowser(context, connector.id)
                onConnected()
            } catch (e: Throwable) {
                if (!e.isCancellation) {
                    if (onError != null) onError(e.userMessage) else world.reportSyncError(e)
                }
            } finally {
                busy = false
            }
        }
    }

    if (large) {
        JunoButton(text = title, onClick = ::start, modifier = modifier.fillMaxWidth(), enabled = enabled)
    } else {
        Box(modifier) { SettingsPill(text = title, onClick = ::start, enabled = enabled) }
    }
    if (keySheet) {
        ApiKeyConnectSheet(connector = connector, onDismiss = { keySheet = false }, onConnected = onConnected)
    }
}
