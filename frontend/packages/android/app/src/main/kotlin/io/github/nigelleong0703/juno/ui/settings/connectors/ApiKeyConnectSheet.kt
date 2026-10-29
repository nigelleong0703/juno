package io.github.nigelleong0703.juno.ui.settings.connectors

import io.github.nigelleong0703.juno.ui.components.ButtonSize
import io.github.nigelleong0703.juno.ui.components.openSignInPage
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.state.ConnectorView
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.connectApiKey
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.components.JunoTextField
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.settings.SettingsError
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.launch

/**
 * An API-key connector's key: the field's label comes from the server, "Where do I find it?" opens its help page.
 * Write-only: the key lives in a plain `remember` (never saved state) and is cleared once the server accepts it.
 * The sheet cannot be dismissed while the key is being sent.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ApiKeyConnectSheet(connector: ConnectorView, onDismiss: () -> Unit, onConnected: () -> Unit) {
    val world = LocalWorld.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val c = JunoTheme.colors
    var key by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val label = "API key"
    val helpUrl: String? = null
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true, confirmValueChange = { !busy })

    fun connect() {
        val secret = key.trim()
        busy = true
        error = null
        scope.launch {
            try {
                world.connectApiKey(connector.id, secret)
                key = ""
                onConnected()
                onDismiss()
            } catch (e: Throwable) {
                if (!e.isCancellation) error = e.userMessage
            } finally {
                busy = false
            }
        }
    }

    ModalBottomSheet(
        onDismissRequest = { if (!busy) onDismiss() },
        sheetState = sheetState,
        containerColor = c.canvas,
    ) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text("Connect ${connector.name.orEmpty()}", style = junoText(TextSize.Xl, FontWeight.SemiBold), color = c.fg)
            JunoTextField(
                value = key,
                onValueChange = { key = it },
                label = label,
                modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    keyboardType = KeyboardType.Password,
                ),
                visualTransformation = PasswordVisualTransformation(),
            )
            error?.let { SettingsError(it) }
            helpUrl?.let {
                JunoButton(
                    text = "Where do I find it?", onClick = { context.openSignInPage(it) },
                    variant = ButtonVariant.Secondary, size = ButtonSize.Large,
                )
            }
            Text("Stored encrypted and never shown again.", style = junoText(TextSize.Xs), color = c.fgSubtle)
            JunoButton(
                text = "Connect", onClick = ::connect,
                modifier = Modifier.fillMaxWidth(), enabled = key.isNotBlank() && !busy,
            )
        }
    }
}
