package io.github.nigelleong0703.juno.ui.uidoc

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.ui.components.LibraryImage
import io.github.nigelleong0703.juno.ui.components.RemoteImage
import io.github.nigelleong0703.juno.ui.components.openLink
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** Display blocks sit on the grey tile; inside a group the group is the tile, so there is none. */
@Composable
internal fun UiTile(nested: Boolean, content: @Composable () -> Unit) {
    if (nested) {
        content()
        return
    }
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.tile)).background(JunoTheme.colors.tile).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) { content() }
}

/** Label on the left (muted), value on the right; emphasis makes the value semibold. */
@Composable
internal fun UiFacts(rows: List<UiFact>) {
    val c = JunoTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        rows.forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.Top) {
                Text(row.label, style = junoText(TextSize.Base), color = c.fgMuted, modifier = Modifier.weight(1f))
                Text(
                    row.value, style = junoText(TextSize.Base, if (row.emphasis) FontWeight.SemiBold else FontWeight.Normal),
                    color = c.fg, textAlign = TextAlign.End,
                )
            }
        }
    }
}

/** How many item rows show before "Show more". */
internal const val ITEM_CAP = 5
/** How many table rows show before "Show more". */
internal const val TABLE_CAP = 6

@Composable
internal fun UiItems(rows: List<UiItemRow>, total: UiFact?) {
    val c = JunoTheme.colors
    var all by remember { mutableStateOf(false) }
    val shown = if (all) rows else rows.take(ITEM_CAP)
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        shown.forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                row.imageUrl?.let { RemoteImage(it, Modifier.size(40.dp).clip(RoundedCornerShape(8.dp))) }
                Column(Modifier.weight(1f)) {
                    Text(row.name, style = junoText(TextSize.Base), color = c.fg, maxLines = 2)
                    row.detail?.let { Text(it, style = junoText(TextSize.Sm), color = c.fgMuted, maxLines = 1) }
                }
                row.quantity?.takeIf { it > 1 }?.let { Text("×$it", style = junoText(TextSize.Base), color = c.fgMuted) }
                row.price?.let { Text(it, style = junoText(TextSize.Base), color = c.fg) }
            }
        }
        if (rows.size > shown.size) ShowMoreText(rows.size - shown.size) { all = true }
        total?.let {
            HorizontalDivider(color = c.border)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(it.label, style = junoText(TextSize.Md), color = c.fg, modifier = Modifier.weight(1f))
                Text(it.value, style = junoText(TextSize.Md, FontWeight.SemiBold), color = c.fg)
            }
        }
    }
}

/** Columns side by side, scrolling sideways on a phone. Short rows are padded, long rows cut (parser). */
@Composable
internal fun UiTable(columns: List<String>, rows: List<List<String>>) {
    val c = JunoTheme.colors
    var all by remember { mutableStateOf(false) }
    val shown = if (all) rows else rows.take(TABLE_CAP)
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(Modifier.horizontalScroll(rememberScrollState())) {
            Row { columns.forEach { Text(it, style = junoText(TextSize.Sm, FontWeight.Medium), color = c.fgMuted, modifier = Modifier.width(120.dp)) } }
            shown.forEach { row ->
                HorizontalDivider(color = c.border, modifier = Modifier.padding(vertical = 4.dp))
                Row { row.forEach { Text(it, style = junoText(TextSize.Sm), color = c.fg, maxLines = 1, modifier = Modifier.width(120.dp)) } }
            }
        }
        if (rows.size > shown.size) ShowMoreText(rows.size - shown.size) { all = true }
    }
}

/** Tinted by tone: warning and success take the status colours, info is neutral (no blue anywhere). Solid, not translucent. */
@Composable
internal fun UiNotice(tone: String, text: String) {
    val c = JunoTheme.colors
    val (icon, ink, surface) = when (tone) {
        "warning" -> Triple(JunoIcons.Warning, JunoStatus.warning, if (c.isDark) WarningDark else WarningLight)
        "success" -> Triple(JunoIcons.CheckCircle, JunoStatus.success, if (c.isDark) SuccessDark else SuccessLight)
        else -> Triple(JunoIcons.Info, c.fgSubtle, c.tile)
    }
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.tile)).background(surface).padding(horizontal = 14.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top,
    ) {
        Icon(icon, contentDescription = null, tint = ink, modifier = Modifier.size(20.dp))
        Text(text, style = junoText(TextSize.Base), color = c.fg, modifier = Modifier.weight(1f))
    }
}

private val WarningLight = androidx.compose.ui.graphics.Color(0xFFFFF3E0)
private val WarningDark = androidx.compose.ui.graphics.Color(0xFF3A2C14)
private val SuccessLight = androidx.compose.ui.graphics.Color(0xFFE6F7EE)
private val SuccessDark = androidx.compose.ui.graphics.Color(0xFF12301F)

/** A tappable link card: title, subtitle and an arrow; opens the browser (https only, see the parser). */
@Composable
internal fun UiLink(url: String, title: String, subtitle: String?) {
    val c = JunoTheme.colors
    val context = LocalContext.current
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.tile)).background(c.tile)
            .clickable { context.openLink(url, webOnly = true) }
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = junoText(TextSize.Base, FontWeight.Medium), color = c.fg, maxLines = 1)
            subtitle?.let { Text(it, style = junoText(TextSize.Sm), color = c.fgMuted, maxLines = 1) }
        }
        Spacer(Modifier.width(8.dp))
        Icon(JunoIcons.ArrowUpRight, contentDescription = null, tint = c.fgSubtle, modifier = Modifier.size(18.dp))
    }
}

/** A library picture, loaded through the signed-in download. The frame is fixed so the row never jumps when it arrives. */
@Composable
internal fun UiImageBlock(libraryId: String, caption: String?) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        LibraryImage(libraryId, Modifier.fillMaxWidth().aspectRatio(4f / 3f).clip(RoundedCornerShape(Radius.tile)))
        caption?.let { Text(it, style = junoText(TextSize.Sm), color = JunoTheme.colors.fgMuted) }
    }
}

/** A titled group: its own tile, with the blocks inside drawn without a tile of their own. */
@Composable
internal fun UiGroup(group: UiBlock.Group) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.tile)).background(JunoTheme.colors.tile).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        group.title?.let { Text(it, style = junoText(TextSize.Md, FontWeight.SemiBold), color = JunoTheme.colors.fg) }
        group.blocks.forEach { UiBlockView(it, nested = true, answering = null) }
    }
}

@Composable
internal fun ShowMoreText(hidden: Int, onClick: () -> Unit) {
    Text(
        "Show $hidden more", style = junoText(TextSize.Sm, FontWeight.Medium), color = JunoTheme.colors.fgMuted,
        modifier = Modifier.clickable(onClick = onClick).padding(top = 2.dp),
    )
}
