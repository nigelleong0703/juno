package io.github.nigelleong0703.juno.ui.chat

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.R
import io.github.nigelleong0703.juno.contract.DecisionBrief
import io.github.nigelleong0703.juno.ui.components.JunoIcons
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** An app on the owner's Mac has no icon the phone can load: one generic app glyph in the same frame for all of them. */
@Composable
fun AppGlyph(size: androidx.compose.ui.unit.Dp = 36.dp) {
    val c = JunoTheme.colors
    val shape = RoundedCornerShape(size * 0.3f)
    Box(Modifier.size(size).clip(shape).background(c.canvas).border(0.5.dp, c.border, shape), contentAlignment = Alignment.Center) {
        Icon(JunoIcons.Computer, null, tint = c.fgMuted, modifier = Modifier.size(size * 0.5f))
    }
}

/**
 * A decision's picture (iOS `PlatformIcon` / `BrandIcon`): Juno's bean for a Juno ask, the site's initial for a site
 * (no favicon fetch on Android yet), else the category symbol. Canvas square, hairline, radius 0.3 of the size.
 */
@Composable
fun PlatformIcon(brief: DecisionBrief?, size: androidx.compose.ui.unit.Dp = 36.dp) {
    val c = JunoTheme.colors
    val platform = brief?.platform
    val symbol = DecisionWords.icon(brief?.primary)
    val shape = RoundedCornerShape(size * 0.3f)
    Box(
        Modifier.size(size).clip(shape).background(c.canvas).border(0.5.dp, c.border, shape),
        contentAlignment = Alignment.Center,
    ) {
        when (platform?.kind) {
            "juno" -> Image(painterResource(R.drawable.juno_bean), null, Modifier.size(size * 0.8f))
            "site" -> Text(
                (platform.host ?: platform.name).orEmpty().removePrefix("www.").take(1).uppercase(),
                color = c.fgMuted, style = junoText(TextSize.Base, FontWeight.SemiBold),
            )
            else -> Icon(symbol, null, tint = c.fgMuted, modifier = Modifier.size(size * 0.5f))
        }
    }
}
