package io.github.nigelleong0703.juno.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/**
 * Placeholder for a screen that is not ported yet. A feature agent replaces the `TodoScreen("...")` call in
 * `JunoNavHost` with the real screen composable and deletes nothing else.
 */
@Composable
fun TodoScreen(feature: String) {
    val c = JunoTheme.colors
    Box(Modifier.fillMaxSize().background(c.canvas), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(feature, style = junoText(TextSize.Lg, FontWeight.SemiBold), color = c.fg)
            Text("Not ported yet", style = junoText(TextSize.Sm), color = c.fgSubtle)
        }
    }
}
