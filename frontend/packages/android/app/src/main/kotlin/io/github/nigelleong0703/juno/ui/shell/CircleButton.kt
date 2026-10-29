package io.github.nigelleong0703.juno.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.ui.theme.JunoTheme

/**
 * The iOS 44 pt round control (`RoundGlassButton`, the tab headers, the drawer's search and settings). Liquid glass is
 * replaced by a flat `card` surface with a hairline `border` and a soft shadow, as the owner asked.
 */
@Composable
fun CircleButton(
    label: String,
    modifier: Modifier = Modifier,
    width: Dp = 44.dp,
    shape: Shape = CircleShape,
    onClick: () -> Unit,
    content: @Composable BoxScope.() -> Unit,
) {
    val c = JunoTheme.colors
    Box(
        modifier
            .size(width, 44.dp)
            .shadow(elevation = 4.dp, shape = shape, ambientColor = SHADOW, spotColor = SHADOW)
            .clip(shape)
            .background(c.card)
            .border(1.dp, c.border, shape)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
        content = content,
    )
}

/** A 22 dp outline icon in a [CircleButton]. */
@Composable
fun CircleIcon(icon: ImageVector, label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    CircleButton(label, modifier, onClick = onClick) {
        Icon(icon, contentDescription = null, tint = JunoTheme.colors.fg, modifier = Modifier.size(22.dp))
    }
}

private val SHADOW = Color.Black.copy(alpha = 0.10f)
