package io.github.nigelleong0703.juno.ui.theme

import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.ProvideTextStyle
import android.app.Activity
import android.view.Window
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf

private val LocalJunoColors = staticCompositionLocalOf { JunoColors.light }

/** `JunoTheme.colors.fg`, the Android twin of iOS `Theme.fg`. Read it inside `JunoTheme { }`. */
object JunoTheme {
    val colors: JunoColors
        @Composable @ReadOnlyComposable get() = LocalJunoColors.current
}

/**
 * Provides the Juno tokens and a Material scheme mapped onto them, so stock Material components (text fields,
 * scaffolds, buttons) come out neutral without per-screen overrides.
 *
 * Owner rule: Android matches the iPhone design exactly EXCEPT liquid glass. Wherever iOS uses glass / blur /
 * material (glassEffect, ultraThinMaterial, translucent bars, `.glass` buttons), use a flat opaque token surface
 * (`canvas`, `panel`, `card`, `muted`) with a hairline `border`; never blur or alpha-blend a surface.
 */
@Composable
fun JunoTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val c = if (dark) JunoColors.dark else JunoColors.light
    val scheme = (if (dark) darkColorScheme() else lightColorScheme()).copy(
        primary = c.primary, onPrimary = c.primaryFg, background = c.canvas, onBackground = c.fg,
        surface = c.canvas, onSurface = c.fg, surfaceVariant = c.muted, onSurfaceVariant = c.fgMuted,
        surfaceContainer = c.panel, surfaceContainerHigh = c.card, outline = c.border, outlineVariant = c.border,
        secondaryContainer = c.selected, onSecondaryContainer = c.fg, error = JunoStatus.danger,
    )
    SystemBarIcons((LocalContext.current as? Activity)?.window, dark)
    CompositionLocalProvider(LocalJunoColors provides c) {
        MaterialTheme(colorScheme = scheme) {
            // A Text without its own style inherits this; keep its glyphs centred like the app's own styles.
            ProvideTextStyle(LocalTextStyle.current.copy(lineHeightStyle = CenteredLines), content)
        }
    }
}

/** Status-bar icons dark on a light app theme and light on a dark one, whatever the system theme says. */
@Composable
fun SystemBarIcons(window: Window?, dark: Boolean) {
    val view = LocalView.current
    SideEffect { window?.let { WindowCompat.getInsetsController(it, view).isAppearanceLightStatusBars = !dark } }
}
