package io.github.nigelleong0703.juno.ui.chat

import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.Dp

/** Samples of the alpha ramp; the gradient is drawn with this many stops, so the curve reads smooth. */
private const val RAMP_STOPS = 32

/**
 * Fades the content out at the top (under the floating header) and at the bottom (into the composer), as iOS's soft
 * scroll-edge effect does: a gradient alpha mask, not a blur.
 * - Top: fully transparent down to [top] (the header's bottom edge), then eases (smoothstep) to opaque over [topFade],
 *   so the header band and the first part of the fade below it are strongly faded.
 * - Bottom: opaque until [bottom] above the edge, then eases to transparent at the edge (into the composer).
 * Both ramps are evaluated per sample and combined with min.
 */
fun Modifier.edgeFade(top: Dp, topFade: Dp, bottom: Dp): Modifier = graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
    .drawWithContent {
        drawContent()
        val h = size.height
        if (h <= 0f) return@drawWithContent
        val topPx = top.toPx().coerceAtLeast(0f)
        val fadePx = topFade.toPx().coerceAtLeast(1f)
        val bottomPx = bottom.toPx().coerceAtLeast(1f)
        val stops = Array(RAMP_STOPS + 1) { i ->
            val y = h * i / RAMP_STOPS
            val fromTop = smoothstep((y - topPx) / fadePx)
            val fromBottom = smoothstep((h - y) / bottomPx)
            (i.toFloat() / RAMP_STOPS) to Color.Black.copy(alpha = minOf(fromTop, fromBottom))
        }
        drawRect(
            brush = Brush.verticalGradient(colorStops = stops, startY = 0f, endY = h),
            topLeft = Offset.Zero, size = size, blendMode = BlendMode.DstIn,
        )
    }

private fun smoothstep(x: Float): Float {
    val t = x.coerceIn(0f, 1f)
    return t * t * (3f - 2f * t)
}
