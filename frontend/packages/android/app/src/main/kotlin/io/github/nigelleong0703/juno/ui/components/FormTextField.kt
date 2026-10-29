package io.github.nigelleong0703.juno.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** iOS `.inputField()`: solid input fill, hairline border, 14dp corners; grows from [minLines] to [maxLines]. */
@Composable
fun FormTextField(
    value: String, onChange: (String) -> Unit, placeholder: String = "", modifier: Modifier = Modifier,
    minLines: Int = 1, maxLines: Int = 1, enabled: Boolean = true, keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
) {
    val c = JunoTheme.colors
    BasicTextField(
        value = value, onValueChange = onChange, enabled = enabled, minLines = minLines, maxLines = maxLines, singleLine = maxLines == 1,
        textStyle = junoText(TextSize.Lg).copy(color = if (enabled) c.fg else c.fgMuted), cursorBrush = SolidColor(c.fg), keyboardOptions = keyboardOptions,
        modifier = modifier.fillMaxWidth(),
        decorationBox = { inner ->
            Box(Modifier.fillMaxWidth().background(c.inputBg, RoundedCornerShape(Radius.lg)).border(1.dp, c.border, RoundedCornerShape(Radius.lg)).padding(horizontal = 14.dp, vertical = 12.dp)) {
                if (value.isEmpty()) Text(placeholder, style = junoText(TextSize.Lg), color = c.fgSubtle)
                inner()
            }
        },
    )
}
