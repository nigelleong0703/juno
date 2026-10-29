package io.github.nigelleong0703.juno.ui.components

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.foundation.layout.height
import androidx.compose.ui.unit.sp
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** The short labels of a suggestion's buttons (iOS `CardButton.label`): Chinese when the card's own text is Chinese. */
enum class CardLabel {
    Start, NotNow, DoIt, Draft;

    fun text(forCardText: String): String {
        val cjk = forCardText.codePoints().anyMatch { it in 0x3040..0x30FF || it in 0x3400..0x9FFF || it in 0xAC00..0xD7AF }
        return if (cjk) when (this) {
            Start -> "开始"; NotNow -> "以后再说"; DoIt -> "去做"; Draft -> "草稿"
        } else when (this) {
            Start -> "Start"; NotNow -> "Not now"; DoIt -> "Do it"; Draft -> "Draft"
        }
    }
}

/** One explicit button on a card: [link] is the muted text button at the left, [ghost] the outlined one. */
data class CardAction(val label: String, val style: Style = Style.Primary, val onClick: () -> Unit) {
    enum class Style { Primary, Ghost, Link }
}

/**
 * An idea or a suggestion as a compact card (iOS `SuggestionCard`): leading avatar or tile, a title up to two lines,
 * one muted line, then either a chevron (the whole card opens) or the explicit buttons at the bottom. Long-press
 * offers "Not interested" when [onNotInterested] is set.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SuggestionCard(
    title: String,
    subtitle: String,
    leading: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    buttons: List<CardAction> = emptyList(),
    onOpen: (() -> Unit)? = null,
    onNotInterested: (() -> Unit)? = null,
    // In a row of cards (iOS `fillsHeight`): every card is as tall as a two-line title, so the buttons line up.
    fillsHeight: Boolean = false,
    // An idea's "Less like this": a muted text button at the left that opens a menu of written-out choices.
    lessLabel: String? = null,
    lessItems: List<CardAction> = emptyList(),
    dismissLabel: String = "Not interested",
) {
    val c = JunoTheme.colors
    var menuOpen by remember { mutableStateOf(false) }
    var lessOpen by remember { mutableStateOf(false) }
    var titleLines by remember { mutableIntStateOf(2) }
    val tap = onOpen?.takeIf { buttons.isEmpty() }
    Column(
        modifier
            .fillMaxWidth()
            .feedCard(Modifier.combinedClickable(enabled = tap != null || onNotInterested != null, onClick = { tap?.invoke() }, onLongClick = onNotInterested?.let { { menuOpen = true } })),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            leading()
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title, style = junoText(TextSize.Md, FontWeight.SemiBold), color = c.fg, maxLines = 2, onTextLayout = { titleLines = it.lineCount })
                if (subtitle.isNotEmpty()) Text(subtitle, style = junoText(TextSize.Sm), color = c.fgMuted, maxLines = 1)
            }
            if (buttons.isEmpty()) Icon(JunoIcons.ChevronRight, contentDescription = null, tint = c.fgSubtle)
        }
        // A one-line title leaves its second line as space above the buttons, as iOS's spacer does.
        if (fillsHeight && titleLines < 2) Spacer(Modifier.height(with(LocalDensity.current) { TextSize.Md.lineHeight.sp.toDp() } - 12.dp))
        if (buttons.isNotEmpty()) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                buttons.filter { it.style == CardAction.Style.Link }.forEach { action ->
                    Text(action.label, style = junoText(TextSize.Sm), color = c.fgMuted, modifier = Modifier.clickable(onClick = action.onClick))
                }
                if (lessLabel != null && lessItems.isNotEmpty()) {
                    Box {
                        Text(lessLabel, style = junoText(TextSize.Sm), color = c.fgMuted, modifier = Modifier.clickable { lessOpen = true })
                        DropdownMenu(expanded = lessOpen, onDismissRequest = { lessOpen = false }) {
                            lessItems.forEach { item ->
                                DropdownMenuItem(text = { Text(item.label, color = c.fg) }, onClick = { lessOpen = false; item.onClick() })
                            }
                        }
                    }
                }
                Spacer(Modifier.weight(1f))
                buttons.filter { it.style != CardAction.Style.Link }.forEach { action ->
                    CardButton(action)
                }
            }
        }
        if (onNotInterested != null) {
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                DropdownMenuItem(
                    text = { Text(dismissLabel, color = c.fg) },
                    leadingIcon = { Icon(JunoIcons.ThumbDown, contentDescription = null, tint = c.fg) },
                    onClick = { menuOpen = false; onNotInterested() },
                )
            }
        }
    }
}

@Composable
private fun CardButton(action: CardAction) {
    JunoButton(
        text = action.label, onClick = action.onClick, size = ButtonSize.Sm,
        variant = if (action.style == CardAction.Style.Primary) ButtonVariant.Primary else ButtonVariant.Secondary,
    )
}
