package io.github.nigelleong0703.juno.ui.settings.about

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/**
 * A multi-line input with the surface of `JunoTextField` (which is single-line only). Grows with its text from [minLines].
 * TODO: fold into JunoTextField once that takes a line range; the About you and Your details editors both use this.
 */
@Composable
fun SettingsTextArea(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    minLines: Int = 3,
    enabled: Boolean = true,
) {
    val c = JunoTheme.colors
    OutlinedTextField(
        value = value, onValueChange = onValueChange, enabled = enabled,
        modifier = modifier.fillMaxWidth(), minLines = minLines,
        label = label?.let { text -> { Text(text) } }, textStyle = junoText(TextSize.Lg), shape = RoundedCornerShape(Radius.lg),
        colors = OutlinedTextFieldDefaults.colors(
            focusedContainerColor = c.inputBg, unfocusedContainerColor = c.inputBg,
            focusedBorderColor = c.fg, unfocusedBorderColor = c.border, cursorColor = c.fg,
            focusedLabelColor = c.fgMuted, unfocusedLabelColor = c.fgSubtle,
        ),
    )
}
