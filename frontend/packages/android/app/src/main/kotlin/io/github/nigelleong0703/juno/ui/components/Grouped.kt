package io.github.nigelleong0703.juno.ui.components

import io.github.nigelleong0703.juno.ui.theme.CenteredLines
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsTopHeight
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Size
import androidx.compose.material3.DividerDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme

/** The trailing marker of a [GroupedRow]: none, or a chevron (the row opens something). */
enum class RowMarker { None, Chevron }

/** The page bar's leading control: the back chevron, the close X of a sheet, or the "Cancel" pill (iOS New chat). */
enum class PageLeading { Back, Close, Cancel }

/** The accent blue of text actions (Muse Android "Connect"). Not a surface colour. */
val JunoAccentBlue = Color(0xFF0A7CFF)

/** Muse metrics for settings pages: 18 sp page title, 16 sp rows, 13 sp subtitles and section text. */
private val PageTitleStyle = TextStyle(fontSize = 18.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold, lineHeightStyle = CenteredLines)
private val RowTitleStyle = TextStyle(fontSize = 16.sp, lineHeight = 21.sp, lineHeightStyle = CenteredLines)
private val RowSubtitleStyle = TextStyle(fontSize = 13.sp, lineHeight = 17.sp, lineHeightStyle = CenteredLines)
private val SectionTextStyle = TextStyle(fontSize = 13.sp, lineHeight = 17.sp, fontWeight = FontWeight.Medium, lineHeightStyle = CenteredLines)
private val ValueStyle = TextStyle(fontSize = 15.sp, lineHeight = 20.sp, lineHeightStyle = CenteredLines)

/** Corner of a grouped block (Muse ~24 dp). */
private val GROUP_RADIUS = 24.dp
private val ROW_MIN_HEIGHT = 52.dp
private val ROW_INSET = 16.dp

/**
 * A full-screen settings page (Muse Android): the status-bar inset, the [PageHeader], then a scrolling column of
 * [GroupedSection]s on the canvas with 16 dp side margins. [bottom] is pinned under the list. The page draws no
 * status-bar background; the canvas starts under it.
 */
@Composable
fun GroupedPage(
    title: String,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    leading: PageLeading = PageLeading.Back,
    actions: @Composable RowScope.() -> Unit = {},
    bottom: (@Composable ColumnScope.() -> Unit)? = null,
    scrollable: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    val c = JunoTheme.colors
    Column(modifier.fillMaxSize().navigationBarsPadding()) {
        Spacer(Modifier.windowInsetsTopHeight(WindowInsets.statusBars))
        Column(Modifier.weight(1f).fillMaxWidth().background(c.canvas)) {
            PageHeader(title, onBack, leading, actions)
            // A non-scrolling page (the Routines calendar) hands the content the height left under the header.
            Column(
                Modifier.weight(1f).fillMaxWidth().padding(horizontal = 16.dp)
                    .then(if (scrollable) Modifier.verticalScroll(rememberScrollState()).padding(bottom = 24.dp) else Modifier),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Column(
                    Modifier.widthIn(max = 640.dp).fillMaxWidth().then(if (scrollable) Modifier else Modifier.weight(1f)),
                    verticalArrangement = Arrangement.spacedBy(12.dp), content = content,
                )
            }
        }
        bottom?.let {
            Column(Modifier.widthIn(max = 640.dp).fillMaxWidth().background(c.canvas).padding(horizontal = 16.dp).padding(bottom = 12.dp), content = it)
        }
    }
}

/**
 * The Muse page header: no grabber, a 48 dp circle button at the leading edge (‹ back or ✕ close) and the title
 * centred at 18 sp semibold. [actions] sit at the trailing edge. Transparent, no hairline.
 */
@Composable
fun PageHeader(
    title: String,
    onBack: () -> Unit,
    leading: PageLeading = PageLeading.Back,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val c = JunoTheme.colors
    Box(Modifier.fillMaxWidth().height(60.dp).padding(horizontal = 16.dp)) {
        Text(
            title, style = PageTitleStyle, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center, modifier = Modifier.align(Alignment.Center).padding(horizontal = 56.dp),
        )
        Row(Modifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically) {
            when (leading) {
                PageLeading.Back -> HeaderCircle(JunoIcons.ChevronLeft, "Back", onClick = onBack)
                PageLeading.Close -> HeaderCircle(JunoIcons.Close, "Close", onClick = onBack)
                PageLeading.Cancel -> CancelPill(onBack)
            }
            Spacer(Modifier.weight(1f))
            actions()
        }
    }
}

/** The 48 dp muted circle of a page header. */
@Composable
private fun HeaderCircle(icon: ImageVector, label: String, onClick: () -> Unit) {
    val c = JunoTheme.colors
    Box(
        Modifier.size(48.dp).clip(CircleShape).background(c.muted, CircleShape)
            .clickable(role = Role.Button, onClick = onClick).semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = c.fg, modifier = Modifier.size(22.dp))
    }
}

/** The "Cancel" pill of a creation sheet (iOS New chat), on the muted token. */
@Composable
private fun CancelPill(onClick: () -> Unit) {
    val c = JunoTheme.colors
    Box(
        Modifier.height(40.dp).clip(CircleShape).background(c.muted, CircleShape)
            .clickable(role = Role.Button, onClick = onClick).padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text("Cancel", style = RowTitleStyle, color = c.fg)
    }
}

/**
 * A Muse grouped block: an optional [header] (13 sp medium, muted, outside the block) above a rounded `muted` block
 * with no border, and an optional [footer] (13 sp muted) under it.
 */
@Composable
fun GroupedSection(header: String? = null, footer: String? = null, content: @Composable ColumnScope.() -> Unit) {
    val c = JunoTheme.colors
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        header?.let { Text(it, style = SectionTextStyle, color = c.fgMuted, modifier = Modifier.padding(start = 16.dp)) }
        // Rows draw their hairline on top; the block paints over the first one, so lines only sit between rows.
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(GROUP_RADIUS)).background(c.muted)
                .drawWithContent { drawContent(); drawRect(c.muted, size = Size(size.width, (DividerDefaults.Thickness * 2).toPx())) },
            content = content,
        )
        footer?.let { Text(it, style = RowSubtitleStyle, color = c.fgMuted, modifier = Modifier.padding(horizontal = 16.dp)) }
    }
}

/**
 * One row of a [GroupedSection]: 52 dp minimum, an optional [icon] (24 dp line icon) or [leading] picture, the title
 * (16 sp), an optional [subtitle] (13 sp muted), [extra] lines under it, an optional [value] (15 sp muted), a [trailing]
 * control and a [marker] chevron. The hairline above the row is inset 16 dp. [destructive] tints the title red.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun GroupedRow(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    value: String? = null,
    warning: Boolean = false,
    destructive: Boolean = false,
    marker: RowMarker = RowMarker.None,
    icon: ImageVector? = null,
    leading: (@Composable () -> Unit)? = null,
    extra: (@Composable () -> Unit)? = null,
    trailing: (@Composable RowScope.() -> Unit)? = null,
    onClick: (() -> Unit)? = null,
    onLongClick: (() -> Unit)? = null,
) {
    val c = JunoTheme.colors
    val titleColor = if (destructive) JunoStatus.danger else c.fg
    Column(modifier.fillMaxWidth()) {
        HorizontalDivider(color = c.border, modifier = Modifier.padding(start = ROW_INSET))
        Row(
            Modifier.fillMaxWidth().heightIn(min = ROW_MIN_HEIGHT)
                .then(
                    if (onClick != null || onLongClick != null) Modifier.combinedClickable(onClick = onClick ?: {}, onLongClick = onLongClick)
                    else Modifier,
                )
                .padding(horizontal = ROW_INSET, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            leading?.let { it(); Spacer(Modifier.width(12.dp)) }
            icon?.let {
                Icon(it, contentDescription = null, tint = c.fg, modifier = Modifier.size(24.dp))
                Spacer(Modifier.width(16.dp))
            }
            Column(Modifier.weight(1f)) {
                Text(title, style = RowTitleStyle, color = titleColor, maxLines = 2, overflow = TextOverflow.Ellipsis)
                subtitle?.let {
                    Text(it, style = RowSubtitleStyle, color = if (warning) JunoStatus.warning else c.fgMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                extra?.invoke()
            }
            value?.let {
                Spacer(Modifier.width(12.dp))
                Text(it, style = ValueStyle, color = c.fgMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            trailing?.let { Spacer(Modifier.width(12.dp)); it() }
            if (marker == RowMarker.Chevron) {
                Spacer(Modifier.width(8.dp))
                Icon(JunoIcons.ChevronRight, null, tint = c.fgSubtle, modifier = Modifier.size(16.dp))
            }
        }
    }
}

/**
 * A single-choice row (Muse inline choice): the [title] with an optional [subtitle], and a check at the trailing end on
 * the chosen one. Used in place of dropdown menus and pickers.
 */
@Composable
fun GroupedChoiceRow(title: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, subtitle: String? = null) {
    GroupedRow(
        title, modifier = modifier, subtitle = subtitle, onClick = onClick,
        trailing = {
            if (selected) Icon(JunoIcons.Check, contentDescription = "Selected", tint = JunoTheme.colors.fg, modifier = Modifier.size(20.dp))
            else Spacer(Modifier.size(20.dp))
        },
    )
}

/** The Muse search pill (48 dp, fully rounded, `muted`): a magnifier inside and the query field with a placeholder. */
@Composable
fun GroupedSearchField(value: String, label: String, onChange: (String) -> Unit) {
    val c = JunoTheme.colors
    Row(
        Modifier.fillMaxWidth().height(48.dp).clip(CircleShape).background(c.muted, CircleShape).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(JunoIcons.Search, contentDescription = null, tint = c.fgMuted, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(12.dp))
        Box(Modifier.weight(1f)) {
            if (value.isEmpty()) Text(label, style = RowTitleStyle, color = c.fgSubtle, maxLines = 1)
            BasicTextField(
                value = value, onValueChange = onChange, singleLine = true,
                textStyle = RowTitleStyle.copy(color = c.fg), cursorBrush = SolidColor(c.fg),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}
