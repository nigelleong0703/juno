package io.github.nigelleong0703.juno.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.collectAsState
import coil3.compose.SubcomposeAsyncImage
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import androidx.compose.foundation.shape.RoundedCornerShape

/**
 * A connector's brand logo in a rounded canvas square (iOS `BrandIcon` with a catalog id): the server's PNG at
 * `/v1/brand-icons/{id}.png`, drawn at 60% of the square. [fallback] shows while it loads, when there is no catalog id,
 * or when the picture fails.
 */
@Composable
fun BrandIcon(catalogId: String?, fallback: ImageVector, size: Dp = 36.dp, logoScale: Float = 0.6f) {
    val c = JunoTheme.colors
    val session by LocalWorld.current.session.collectAsState()
    val shape = RoundedCornerShape(size * 0.3f)
    val server = session?.server?.trimEnd('/')
    val fallbackIcon: @Composable () -> Unit = { Icon(fallback, contentDescription = null, tint = c.fgMuted, modifier = Modifier.size(size * 0.5f)) }
    Box(
        Modifier.size(size).clip(shape).background(c.canvas).border(0.5.dp, c.border, shape),
        contentAlignment = Alignment.Center,
    ) {
        if (catalogId != null && server != null) {
            SubcomposeAsyncImage(
                model = "$server/v1/brand-icons/$catalogId.png",
                contentDescription = null,
                contentScale = ContentScale.Fit,
                modifier = Modifier.size(size * logoScale),
                loading = { fallbackIcon() },
                error = { fallbackIcon() },
            )
        } else fallbackIcon()
    }
}
