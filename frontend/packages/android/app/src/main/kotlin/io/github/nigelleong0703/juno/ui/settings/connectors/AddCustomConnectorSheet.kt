package io.github.nigelleong0703.juno.ui.settings.connectors

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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.state.addCustomConnector
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.components.JunoTextField
import io.github.nigelleong0703.juno.ui.settings.SettingsError
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/**
 * Name and address of a remote MCP server; Add needs both. The server is connected from the list afterwards.
 * The address example sits in the help line (the shared text field has no placeholder).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AddCustomConnectorSheet(model: PluginsModel, onDismiss: () -> Unit) {
    val c = JunoTheme.colors
    var name by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true, confirmValueChange = { !busy })
    val ready = name.isNotBlank() && url.isNotBlank() && !busy

    ModalBottomSheet(
        onDismissRequest = { if (!busy) onDismiss() },
        sheetState = sheetState,
        containerColor = c.canvas,
    ) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text("Add custom connector", style = junoText(TextSize.Xl, FontWeight.SemiBold), color = c.fg)
            JunoTextField(
                value = name, onValueChange = { name = it }, label = "Name",
                modifier = Modifier.fillMaxWidth(),
            )
            JunoTextField(
                value = url, onValueChange = { url = it }, label = "URL",
                modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    keyboardType = KeyboardType.Uri,
                ),
            )
            error?.let { SettingsError(it) }
            Text(
                "The address of a remote MCP server, such as https://mcp.example.com/mcp. Connect it from the list afterwards.",
                style = junoText(TextSize.Xs), color = c.fgSubtle,
            )
            JunoButton(
                text = "Add",
                onClick = {
                    busy = true
                    error = null
                    model.perform({ it.addCustomConnector(name.trim(), url.trim()) }) { failure ->
                        busy = false
                        if (failure == null) onDismiss() else error = failure
                    }
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = ready,
            )
        }
    }
}
