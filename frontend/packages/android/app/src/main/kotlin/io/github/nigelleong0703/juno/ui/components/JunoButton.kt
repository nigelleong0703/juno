package io.github.nigelleong0703.juno.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

enum class ButtonVariant { Primary, Secondary, Ghost }

/** iOS `WebButton` sizes: height and horizontal padding in dp, label size and weight. */
enum class ButtonSize(val height: Dp, val horizontalPadding: Dp, val textSize: TextSize, val weight: FontWeight) {
    Xs(24.dp, 10.dp, TextSize.Xs, FontWeight.Medium),
    Sm(32.dp, 12.dp, TextSize.Sm, FontWeight.Medium),
    Regular(36.dp, 16.dp, TextSize.Sm, FontWeight.Medium),
    Large(40.dp, 24.dp, TextSize.Sm, FontWeight.Medium),
    Hero(52.dp, 24.dp, TextSize.Md, FontWeight.SemiBold),
}

/**
 * ui/components/ui/button.tsx as iOS `WebButton`: a fully rounded pill with no border, a flat token fill, and the
 * same pressed (primary fill at 85%, hover tone for the others, scale 0.98) and disabled (whole button at 50%) states.
 */
@Composable
fun JunoButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    variant: ButtonVariant = ButtonVariant.Primary,
    size: ButtonSize = ButtonSize.Sm,
    enabled: Boolean = true,
    /** An optional leading glyph (iOS `Label(..., systemImage:)`). */
    leadingIcon: ImageVector? = null,
    /** A hairline border on the flat fill (the flat stand-in for iOS `.buttonStyle(.glass)`). */
    bordered: Boolean = false,
) {
    val c = JunoTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val (fill, pressedFill, fg) = when (variant) {
        ButtonVariant.Primary -> Triple(c.primary, c.primary.copy(alpha = 0.85f), c.primaryFg)
        ButtonVariant.Secondary -> Triple(c.muted, c.hover, c.fg)
        ButtonVariant.Ghost -> Triple(Color.Transparent, c.hover, c.fg)
    }
    Box(
        modifier = modifier
            .height(size.height)
            .graphicsLayer {
                val s = if (pressed) 0.98f else 1f
                scaleX = s
                scaleY = s
                alpha = if (enabled) 1f else 0.5f
            }
            .background(if (pressed) pressedFill else fill, CircleShape)
            .then(if (bordered) Modifier.border(1.dp, c.border, CircleShape) else Modifier)
            .clickable(
                interactionSource = interaction, indication = null, enabled = enabled,
                role = Role.Button, onClick = onClick,
            )
            .padding(horizontal = size.horizontalPadding),
        contentAlignment = Alignment.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            leadingIcon?.let { Icon(it, contentDescription = null, tint = fg, modifier = Modifier.size(18.dp)) }
            Text(text, style = junoText(size.textSize, size.weight), color = fg, maxLines = 1)
        }
    }
}
