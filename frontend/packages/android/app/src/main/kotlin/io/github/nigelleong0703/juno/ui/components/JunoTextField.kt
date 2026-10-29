package io.github.nigelleong0703.juno.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/**
 * A text field's surface as the web's inputs (iOS `.inputField()`): solid input fill, 1dp hairline border that does
 * not change on focus, 17sp text, 14dp corners, at least 52dp tall. [label] is the placeholder shown while the field
 * is empty, as on iOS. A BasicTextField is used so the field keeps 52dp instead of Material's 56dp minimum.
 */
@Composable
fun JunoTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    secret: Boolean = false,
    trailingIcon: (@Composable () -> Unit)? = null,
    /** A glyph inside the field at its leading edge (iOS search field: the magnifier inside the border). */
    leadingIcon: (@Composable () -> Unit)? = null,
) {
    val c = JunoTheme.colors
    val shape = RoundedCornerShape(Radius.lg)
    BasicTextField(
        value = value, onValueChange = onValueChange, modifier = modifier, singleLine = true,
        textStyle = junoText(TextSize.Lg).copy(color = c.fg), cursorBrush = SolidColor(c.fg),
        keyboardOptions = keyboardOptions, visualTransformation = if (secret) PasswordVisualTransformation() else visualTransformation,
        decorationBox = { inner ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 52.dp)
                    .background(c.inputBg, shape)
                    .border(1.dp, c.border, shape)
                    .padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                leadingIcon?.let { it(); Spacer(Modifier.width(8.dp)) }
                Box(Modifier.weight(1f)) {
                    if (value.isEmpty()) Text(label, style = junoText(TextSize.Lg), color = c.fgSubtle)
                    inner()
                }
                trailingIcon?.invoke()
            }
        },
    )
}
