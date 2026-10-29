package io.github.nigelleong0703.juno.ui.components

import io.github.nigelleong0703.juno.ui.theme.CenteredLines
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** The big page heading that starts a tab (iOS `TabHeading`: `.text(.xxl, .bold)`, 26 pt bold). */
@Composable
fun TabHeading(title: String, modifier: Modifier = Modifier) {
    Text(title, style = junoText(TextSize.Xxl, FontWeight.Bold), color = JunoTheme.colors.fg, modifier = modifier.padding(vertical = 4.dp))
}

/** "Show more" under a capped list (iOS `ShowMore`: the secondary pill). Nothing when everything is shown. */
@Composable
fun ShowMore(shown: Int, total: Int, onMore: () -> Unit, label: String = "Show more") {
    if (total > shown) JunoButton(label, onMore, Modifier.fillMaxWidth(), variant = ButtonVariant.Secondary, size = ButtonSize.Large)
}

/** One muted line standing in for an empty list (iOS `EmptyLine`). */
@Composable
fun EmptyLine(text: String) = Text(text, style = junoText(TextSize.Base), color = JunoTheme.colors.fgSubtle)

/**
 * A centred empty state (iOS `ContentUnavailableView`): a 48 pt grey symbol, the title in `.headline` (17 pt semibold) and
 * the description in `.subheadline` (15 pt regular), both centred.
 */
@Composable
fun EmptyState(icon: ImageVector, title: String, description: String, modifier: Modifier = Modifier) {
    val c = JunoTheme.colors
    Column(modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(icon, contentDescription = null, tint = c.fgSubtle, modifier = Modifier.size(46.dp))
        Spacer(Modifier.height(12.dp))
        Text(title, style = TextStyle(fontSize = 18.sp, lineHeight = 24.sp, fontWeight = FontWeight.Bold, lineHeightStyle = CenteredLines), color = c.fg, textAlign = TextAlign.Center)
        Spacer(Modifier.height(2.dp))
        Text(description, style = junoText(TextSize.Md), color = c.fgMuted, textAlign = TextAlign.Center)
    }
}

/** The surface shared by feed posts, ideas and suggestions: card colour, radius xl, 1 dp hairline, 14 dp inside. */
@Composable
fun Modifier.feedCard(inner: Modifier = Modifier): Modifier = this
    .fillMaxWidth()
    .clip(RoundedCornerShape(Radius.xl))
    .background(JunoTheme.colors.card)
    .border(1.dp, JunoTheme.colors.border, RoundedCornerShape(Radius.xl))
    // Taps and highlights go before the padding, so the pressed state fills the whole rounded card.
    .then(inner)
    .padding(14.dp)

/**
 * Closes a screen that was opened by route, the way the system back gesture does (the nav stack pops). Used where
 * the screen has no nav callback of its own.
 */
@Composable
fun rememberCloseAction(): () -> Unit {
    val dispatcher = LocalOnBackPressedDispatcherOwner.current?.onBackPressedDispatcher
    return { dispatcher?.onBackPressed() }
}

/** A small capsule label such as "Shared", on the muted tile colour. */
@Composable
fun CapsuleBadge(text: String) {
    val c = JunoTheme.colors
    Box(Modifier.clip(CircleShape).background(c.muted).padding(horizontal = 8.dp, vertical = 2.dp)) {
        Text(text, style = junoText(TextSize.Xs, FontWeight.Medium), color = c.fgMuted)
    }
}

/** The 0.5dp hairline used between rows. */
@Composable
fun Hairline(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(0.5.dp).background(JunoTheme.colors.border))
}

/** A pushed page: back arrow, title, then the body on the canvas. */
@Composable
fun PageScaffold(title: String, onBack: (() -> Unit)?, modifier: Modifier = Modifier, actions: @Composable () -> Unit = {}, content: @Composable () -> Unit) {
    val c = JunoTheme.colors
    Column(modifier.fillMaxSize().background(c.canvas)) {
        Row(Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            if (onBack != null) IconButton(onBack) { Icon(JunoIcons.ChevronLeft, "Back", tint = c.fg) } else Spacer(Modifier.size(12.dp))
            Text(title, style = junoText(TextSize.Lg, FontWeight.SemiBold), color = c.fg, maxLines = 1, modifier = Modifier.weight(1f))
            actions()
        }
        Box(Modifier.weight(1f).fillMaxWidth()) { content() }
    }
}

/** A labelled form field (iOS `JunoFormField`). */
@Composable
fun FormField(label: String, optional: Boolean = false, help: String? = null, content: @Composable () -> Unit) {
    val c = JunoTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(label, style = junoText(TextSize.Sm, FontWeight.Medium), color = c.fgMuted)
            if (optional) Text("Optional", style = junoText(TextSize.Sm), color = c.fgSubtle)
        }
        content()
        help?.let { Text(it, style = junoText(TextSize.Xs), color = c.fgSubtle) }
    }
}
