package io.github.nigelleong0703.juno.ui.agents

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.BorderStroke
import io.github.nigelleong0703.juno.ui.components.EmptyLine
import io.github.nigelleong0703.juno.ui.components.ShowMore
import io.github.nigelleong0703.juno.ui.components.JunoSheet
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.state.StatusTone
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.ButtonSize
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

// Small pieces shared by the agents, goals and routines screens (iOS TabHeader, EmptyLine, ShowMore, RoundStopButton,
// PageSection, JunoSheet). Flat opaque surfaces only: no glass.

@Composable
fun TabHeader(title: String, modifier: Modifier = Modifier) =
    Text(title, style = junoText(TextSize.Lg, FontWeight.SemiBold), color = JunoTheme.colors.fg, modifier = modifier.padding(top = 4.dp))

/** The muted rounded card that groups rows. */
@Composable
fun SectionCard(modifier: Modifier = Modifier, radius: Dp = Radius.xl, content: @Composable () -> Unit) =
    Column(modifier.fillMaxWidth().clip(RoundedCornerShape(radius)).background(JunoTheme.colors.muted).padding(horizontal = 16.dp)) { content() }

@Composable
fun JunoSwitch(checked: Boolean, onChange: (Boolean) -> Unit, enabled: Boolean = true) {
    val c = JunoTheme.colors
    val haptic = LocalHapticFeedback.current
    Switch(
        checked = checked, enabled = enabled,
        onCheckedChange = { haptic.performHapticFeedback(if (it) HapticFeedbackType.ToggleOn else HapticFeedbackType.ToggleOff); onChange(it) },
        colors = SwitchDefaults.colors(checkedTrackColor = JunoStatus.success, checkedThumbColor = Color.White, uncheckedTrackColor = c.selected, uncheckedThumbColor = c.card, uncheckedBorderColor = c.border),
    )
}

/** A square icon tile (task rows, routine rows). */
@Composable
fun IconTile(icon: ImageVector, size: Dp = 40.dp, background: Color = JunoTheme.colors.muted, radius: Dp = Radius.lg) =
    Box(Modifier.size(size).clip(RoundedCornerShape(radius)).background(background), contentAlignment = Alignment.Center) {
        Icon(icon, null, tint = JunoTheme.colors.fgMuted, modifier = Modifier.size(size * 0.5f))
    }

fun toneColor(tone: StatusTone, neutral: Color): Color = when (tone) {
    StatusTone.Success -> JunoStatus.success
    StatusTone.Warning -> JunoStatus.warning
    StatusTone.Danger -> JunoStatus.danger
    StatusTone.Neutral -> neutral
}

@Composable
fun StatusPill(text: String, tone: StatusTone) {
    val c = JunoTheme.colors
    val color = toneColor(tone, c.fg)
    Text(
        text, style = junoText(TextSize.Sm, FontWeight.Medium), color = color,
        modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(color.copy(alpha = 0.14f)).padding(horizontal = 10.dp, vertical = 4.dp),
    )
}

@Composable
fun RoundStopButton(onClick: () -> Unit) =
    Box(Modifier.size(32.dp).clip(CircleShape).background(JunoStatus.danger).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Icon(JunoIcons.Stop, "Stop", tint = Color.White, modifier = Modifier.size(16.dp))
    }

@Composable
fun Spinner(size: Dp = 18.dp) = CircularProgressIndicator(Modifier.size(size), strokeWidth = 2.dp, color = JunoTheme.colors.fgMuted)

val hairline: BorderStroke @Composable get() = BorderStroke(1.dp, JunoTheme.colors.border)
