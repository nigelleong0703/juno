package io.github.nigelleong0703.juno.ui.chat

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.BorderStroke
import io.github.nigelleong0703.juno.ui.components.JunoSheet
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

// The request card kit (iOS RequestCardKit): one flat card per thing the agent needs, header + tiles + two equal buttons.

/** Card surface: radius 28, hairline, padding 22 / 16 / 16. Flat token fill (no glass). */
@Composable
fun CardSurface(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val c = JunoTheme.colors
    Column(
        modifier.fillMaxWidth().widthIn(max = 560.dp).clip(RoundedCornerShape(Radius.card)).background(c.requestCard)
            .border(0.5.dp, c.border, RoundedCornerShape(Radius.card)).padding(start = 16.dp, end = 16.dp, top = 22.dp, bottom = 16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) { content() }
}

/** A decided request's row surface: radius 22, hairline, padding 16 / 12. */
@Composable
fun DecidedSurface(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val c = JunoTheme.colors
    Column(
        modifier.fillMaxWidth().widthIn(max = 560.dp).clip(RoundedCornerShape(22.dp)).background(c.requestCard)
            .border(0.5.dp, c.border, RoundedCornerShape(22.dp)).padding(horizontal = 16.dp, vertical = 12.dp),
    ) { content() }
}

@Composable
fun CardHeader(icon: ImageVector, title: String, guidance: String?, notice: String? = null) {
    val c = JunoTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
                Icon(icon, null, tint = c.fg, modifier = Modifier.size(28.dp).padding(2.dp))
                Text(title, color = c.fg, style = junoText(TextSize.Md, FontWeight.SemiBold))
            }
            // One short muted line under the summary (an approval's `notice`); nothing when absent.
            if (!notice.isNullOrEmpty()) Text(notice, color = c.fgSubtle, style = junoText(TextSize.Xs), modifier = Modifier.padding(start = 40.dp))
        }
        if (!guidance.isNullOrEmpty()) Text(guidance, color = c.fgMuted, style = junoText(TextSize.Sm))
    }
}

@Composable
fun RequestCardShell(
    icon: ImageVector, title: String, guidance: String? = null,
    content: @Composable () -> Unit = {}, actions: @Composable () -> Unit = {}, notice: String? = null,
) = CardSurface {
    CardHeader(icon, title, guidance, notice)
    content()
    actions()
}

/** A rounded tile (radius 20): leading picture, title, subtitle, optional chevron. */
@Composable
fun CardTile(title: String, modifier: Modifier = Modifier, subtitle: String? = null, mono: Boolean = false, chevron: Boolean = false, leading: @Composable () -> Unit = {}) {
    val c = JunoTheme.colors
    Row(
        modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.tile)).background(c.tile).padding(horizontal = 14.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        leading()
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, color = c.fg, style = if (mono) junoText(TextSize.Base).copy(fontFamily = FontFamily.Monospace) else junoText(TextSize.Lg))
            if (!subtitle.isNullOrEmpty()) Text(subtitle, color = c.fgSubtle, style = junoText(TextSize.Sm))
        }
        if (chevron) Icon(JunoIcons.ChevronRight, null, tint = c.fgSubtle, modifier = Modifier.size(18.dp))
    }
}

/** The round badge on a tile's left: an icon on the card colour, or initials. */
@Composable
fun TileBadge(icon: ImageVector? = null, initials: String? = null) {
    val c = JunoTheme.colors
    Box(Modifier.size(40.dp).clip(CircleShape).background(c.requestCard), contentAlignment = Alignment.Center) {
        if (icon != null) Icon(icon, null, tint = c.fgMuted, modifier = Modifier.size(20.dp))
        else Text(initials.orEmpty(), color = c.fg, style = junoText(TextSize.Sm, FontWeight.SemiBold))
    }
}

/** A small text label for a decision's kind ("Spending", "Can't be undone"); [warn] tints it. */
@Composable
fun CategoryBadge(text: String, icon: ImageVector?, warn: Boolean = false) {
    val c = JunoTheme.colors
    val fg = if (warn) JunoStatus.warning else c.fgMuted
    Row(
        Modifier.clip(CircleShape).background(if (warn) JunoStatus.warning.copy(alpha = 0.14f) else c.muted).padding(horizontal = 8.dp, vertical = 3.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) Icon(icon, null, tint = fg, modifier = Modifier.size(12.dp))
        Text(text, color = fg, style = junoText(TextSize.Xs, FontWeight.Medium), maxLines = 1)
    }
}

@Composable
fun CardRow(label: String, value: String) {
    val c = JunoTheme.colors
    Row(Modifier.fillMaxWidth().padding(horizontal = 2.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = c.fg, style = junoText(TextSize.Base), modifier = Modifier.weight(1f))
        Spacer(Modifier.size(8.dp))
        Text(value, color = c.fg, style = junoText(TextSize.Base, FontWeight.Medium))
    }
}

/** A pill floating over a picture or a text block: "Review order", "Edit", "Live". Flat card fill with a hairline. */
@Composable
fun CardChip(text: String, modifier: Modifier = Modifier, icon: ImageVector? = null, live: Color? = null, onClick: (() -> Unit)? = null) {
    val c = JunoTheme.colors
    Row(
        modifier.clip(CircleShape).background(c.card).border(0.5.dp, c.border, CircleShape)
            .let { if (onClick != null) it.clickable(onClick = onClick) else it }.padding(horizontal = 12.dp, vertical = 7.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        if (live != null) Box(Modifier.size(7.dp).clip(CircleShape).background(live))
        Text(text, color = c.fg, style = junoText(TextSize.Sm, FontWeight.Medium))
        if (icon != null) Icon(icon, null, tint = c.fg, modifier = Modifier.size(13.dp))
    }
}

/** A subject line and body in a bordered box with an optional corner action (the draft under Send). */
@Composable
fun CardTextBlock(subject: String?, text: String, edit: @Composable () -> Unit = {}) {
    val c = JunoTheme.colors
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.tile)).background(c.requestCard).border(0.5.dp, c.border, RoundedCornerShape(Radius.tile)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (!subject.isNullOrEmpty()) Text(subject, color = c.fg, style = junoText(TextSize.Base, FontWeight.SemiBold))
        Text(text, color = c.fg, style = junoText(TextSize.Base))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) { edit() }
    }
}

/** Two equal buttons: a grey secondary on the left, the primary (black / white) on the right. */
@Composable
fun CardButtons(secondary: String, primary: String, onSecondary: () -> Unit, onPrimary: () -> Unit, primaryEnabled: Boolean = true) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        JunoButton(secondary, onSecondary, Modifier.weight(1f), ButtonVariant.Secondary)
        JunoButton(primary, onPrimary, Modifier.weight(1f), ButtonVariant.Primary, enabled = primaryEnabled)
    }
}

/** Context text under a card's title: all of it up to [lines], past that a "Show more" toggle. */
@Composable
fun ExpandableText(text: String, lines: Int = 6) {
    val c = JunoTheme.colors
    var expanded by remember(text) { mutableStateOf(false) }
    var overflows by remember(text) { mutableStateOf(false) }
    Column {
        Text(
            text, color = c.fgMuted, style = junoText(TextSize.Sm), maxLines = if (expanded) Int.MAX_VALUE else lines, overflow = TextOverflow.Ellipsis,
            onTextLayout = { if (!expanded) overflows = it.hasVisualOverflow },
        )
        if (overflows || expanded) {
            Text(if (expanded) "Show less" else "Show more", color = c.fg, style = junoText(TextSize.Sm, FontWeight.Medium), modifier = Modifier.clickable { expanded = !expanded }.padding(top = 2.dp))
        }
    }
}

/** A bottom sheet on a flat canvas surface (iOS `JunoSheet`): title, optional guidance, content. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatSheet(onDismiss: () -> Unit, title: String, guidance: String? = null, skipPartial: Boolean = true, content: @Composable () -> Unit) {
    val c = JunoTheme.colors
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = skipPartial), containerColor = c.canvas, contentColor = c.fg) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(title, color = c.fg, style = junoText(TextSize.Lg, FontWeight.SemiBold))
            if (!guidance.isNullOrEmpty()) Text(guidance, color = c.fgMuted, style = junoText(TextSize.Sm))
            content()
        }
    }
}

val CardBorder: BorderStroke @Composable get() = BorderStroke(0.5.dp, JunoTheme.colors.border)
