package io.github.nigelleong0703.juno.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.SystemText
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** Trailing "Show N more" / "Show fewer" control for capped lists. */
@Composable
fun ShowMoreButton(label: String, onClick: () -> Unit) {
    Text(
        label, style = SystemText.body, color = JunoTheme.colors.fgMuted,
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 12.dp, horizontal = 16.dp),
    )
}

/** The centred empty line of a list ("Nothing yet…"). */
@Composable
fun SettingsEmpty(text: String) {
    Text(
        text, style = SystemText.footnote, color = JunoTheme.colors.fgSubtle,
        modifier = Modifier.fillMaxWidth().padding(16.dp), textAlign = TextAlign.Center,
    )
}

/** Inline error under a form (iOS red footer text). */
@Composable
fun SettingsError(message: String) {
    Text(message, style = SystemText.footnote, color = JunoStatus.danger, modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp))
}

/** A small pill button (iOS glass capsule replaced by a flat token pill with a hairline). */
@Composable
fun SettingsPill(text: String, onClick: () -> Unit, enabled: Boolean = true) {
    val c = JunoTheme.colors
    Text(
        text, style = junoText(TextSize.Sm, FontWeight.Medium), color = if (enabled) c.fg else c.fgSubtle,
        modifier = Modifier.background(c.muted, CircleShape).border(1.dp, c.border, CircleShape)
            .then(if (enabled) Modifier.clickable(onClick = onClick) else Modifier).padding(horizontal = 14.dp, vertical = 7.dp),
    )
}
