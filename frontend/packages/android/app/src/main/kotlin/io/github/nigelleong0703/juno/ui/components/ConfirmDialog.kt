package io.github.nigelleong0703.juno.ui.components

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.font.FontWeight
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/**
 * An alert with a destructive or plain confirm (iOS `.confirmationDialog`). The confirm is red when [destructive], as on iOS.
 */
@Composable
fun ConfirmDialog(
    title: String,
    body: String?,
    confirm: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    destructive: Boolean = true,
) {
    val c = JunoTheme.colors
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.card,
        title = { Text(title, style = junoText(TextSize.Lg, FontWeight.SemiBold), color = c.fg) },
        text = body?.let { { Text(it, style = junoText(TextSize.Base), color = c.fgMuted) } },
        confirmButton = {
            TextButton(onConfirm) { Text(confirm, color = if (destructive) JunoStatus.danger else c.fg) }
        },
        dismissButton = { TextButton(onDismiss) { Text("Cancel", color = c.fgMuted) } },
    )
}
