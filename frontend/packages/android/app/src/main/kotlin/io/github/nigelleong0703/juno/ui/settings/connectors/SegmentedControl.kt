package io.github.nigelleong0703.juno.ui.settings.connectors

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** iOS segmented picker as a flat token track: the selected segment sits on the card fill. */
@Composable
fun <T> SegmentedControl(
    options: List<Pair<T, String>>,
    selected: T,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val c = JunoTheme.colors
    Row(
        modifier.fillMaxWidth().background(c.muted, CircleShape).border(1.dp, c.border, CircleShape).padding(3.dp),
    ) {
        options.forEach { (value, label) ->
            val on = value == selected
            Box(
                Modifier.weight(1f).clip(CircleShape).background(if (on) c.card else Color.Transparent)
                    .clickable(enabled = enabled && !on) { onSelect(value) }.padding(vertical = 8.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    label, style = junoText(TextSize.Sm, if (on) FontWeight.SemiBold else FontWeight.Normal),
                    color = if (on) c.fg else c.fgMuted,
                )
            }
        }
    }
}
