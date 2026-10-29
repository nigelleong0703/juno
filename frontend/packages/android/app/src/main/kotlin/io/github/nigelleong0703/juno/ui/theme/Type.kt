package io.github.nigelleong0703.juno.ui.theme

import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Text scale (size / line height), the web tokens: 2xs 11/15, xs 12/16, sm 13/18, base 14/20, md 15/22, lg 17/24, xl 22/30, 2xl 26/34. */
enum class TextSize(val size: Float, val lineHeight: Float) {
    Xxs(11f, 15f), Xs(12f, 16f), Sm(13f, 18f), Base(14f, 20f), Md(15f, 22f), Lg(17f, 24f), Xl(22f, 30f), Xxl(26f, 34f),
}

/** The Android twin of iOS `.text(.sm, .medium)`: `Text(..., style = junoText(TextSize.Sm, FontWeight.Medium))`. */
fun junoText(size: TextSize, weight: FontWeight = FontWeight.Normal): TextStyle =
    TextStyle(fontSize = size.size.sp, lineHeight = size.lineHeight.sp, fontWeight = weight, lineHeightStyle = CenteredLines)

/**
 * Glyphs centred in their line height, as iOS lays them out. Compose's default splits the extra height by the font's
 * ascent/descent ratio, which on fonts with a tall ascent (OnePlus's system font) sits text visibly low in a bubble.
 */
val CenteredLines = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None)

/**
 * The iOS system text styles (SwiftUI `.font(.body)` etc.) that List and Form rows and page titles use. The app's small
 * tokens above are for the web-styled surfaces; a native iOS list row is 17 pt, so the Android port of a list uses these.
 */
object SystemText {
    val largeTitle = TextStyle(fontSize = 34.sp, lineHeight = 41.sp, fontWeight = FontWeight.Bold, lineHeightStyle = CenteredLines)
    val title = TextStyle(fontSize = 28.sp, lineHeight = 34.sp, fontWeight = FontWeight.Bold, lineHeightStyle = CenteredLines)
    val title2 = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.Bold, lineHeightStyle = CenteredLines)
    val title3 = TextStyle(fontSize = 20.sp, lineHeight = 25.sp, fontWeight = FontWeight.SemiBold, lineHeightStyle = CenteredLines)
    val headline = TextStyle(fontSize = 17.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold, lineHeightStyle = CenteredLines)
    val body = TextStyle(fontSize = 17.sp, lineHeight = 22.sp, fontWeight = FontWeight.Normal, lineHeightStyle = CenteredLines)
    val callout = TextStyle(fontSize = 16.sp, lineHeight = 21.sp, fontWeight = FontWeight.Normal, lineHeightStyle = CenteredLines)
    val subheadline = TextStyle(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.Normal, lineHeightStyle = CenteredLines)
    val footnote = TextStyle(fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.Normal, lineHeightStyle = CenteredLines)
    val caption = TextStyle(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Normal, lineHeightStyle = CenteredLines)
    val caption2 = TextStyle(fontSize = 11.sp, lineHeight = 13.sp, fontWeight = FontWeight.Normal, lineHeightStyle = CenteredLines)
}

/** Corner radii (dp), as iOS `Radius`. */
object Radius {
    val xs = 4.dp; val sm = 8.dp; val md = 10.dp; val lg = 14.dp; val xl = 16.dp; val xxl = 18.dp
    val composer = 26.dp; val composerGrown = 24.dp
    val screen = 24.dp; val popover = 14.dp
    val card = 28.dp; val tile = 20.dp; val preview = 16.dp
}

/** Agent avatar sizes (dp), as iOS `AvatarSize`. */
object AvatarSize {
    val author = 18.dp; val xs = 20.dp; val sm = 24.dp; val md = 32.dp; val lg = 40.dp
    val header = 56.dp; val profile = 90.dp; val card = 112.dp; val chatHeader = 88.dp
}
