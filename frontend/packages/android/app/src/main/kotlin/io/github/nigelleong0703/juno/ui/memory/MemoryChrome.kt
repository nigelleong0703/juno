package io.github.nigelleong0703.juno.ui.memory

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** A memory sub-page's top bar: a back arrow (when there is somewhere to go back to), the title and optional actions. */
@Composable
fun MemoryBar(title: String, onBack: (() -> Unit)?, trailing: @Composable () -> Unit = {}) {
    val c = JunoTheme.colors
    Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        if (onBack != null) {
            IconButton(onClick = onBack) { Icon(JunoIcons.ChevronLeft, contentDescription = "Back", tint = c.fg) }
        } else {
            Spacer(Modifier.width(12.dp))
        }
        Text(title, style = junoText(TextSize.Md, FontWeight.SemiBold), color = c.fg, modifier = Modifier.weight(1f))
        trailing()
    }
}

/** The muted italic note above a home file, set off by a left rule: it says the text is not part of the file. */
@Composable
fun FileNote(text: String) {
    val c = JunoTheme.colors
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), verticalAlignment = Alignment.Top) {
        Box(Modifier.width(2.dp).fillMaxHeight().background(c.border))
        Spacer(Modifier.width(12.dp))
        Text(
            text, style = junoText(TextSize.Xs).copy(fontStyle = FontStyle.Italic), color = c.fgMuted,
            modifier = Modifier.weight(1f),
        )
    }
}
