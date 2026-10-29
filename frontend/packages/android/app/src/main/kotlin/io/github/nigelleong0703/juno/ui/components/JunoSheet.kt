package io.github.nigelleong0703.juno.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/**
 * A sheet with a title row and a close button (iOS `JunoSheet`). [long] opens it full height; otherwise it opens at
 * medium and can be dragged up. Every sheet is presented from the screen that owns it. [primary] adds a Save-style
 * button after [trailing]; while [loading] the sheet cannot be dismissed and the button is off.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun JunoSheet(
    title: String,
    onDismiss: () -> Unit,
    long: Boolean = false,
    trailing: @Composable () -> Unit = {},
    primary: String? = null,
    primaryEnabled: Boolean = true,
    loading: Boolean = false,
    onPrimary: () -> Unit = {},
    content: @Composable ColumnScope.() -> Unit,
) {
    val c = JunoTheme.colors
    ModalBottomSheet(
        onDismissRequest = { if (!loading) onDismiss() },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = long),
        containerColor = c.canvas,
    ) {
        Column(Modifier.statusBarsPadding().padding(bottom = 24.dp)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onDismiss, enabled = !loading) { Icon(JunoIcons.Close, contentDescription = "Close", tint = c.fg) }
                Text(
                    title, style = junoText(TextSize.Md, FontWeight.SemiBold), color = c.fg,
                    modifier = Modifier.weight(1f).padding(horizontal = 4.dp),
                )
                trailing()
                if (primary != null) JunoButton(primary, onPrimary, enabled = primaryEnabled && !loading, size = ButtonSize.Large)
            }
            Column(
                Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                content = content,
            )
        }
    }
}
