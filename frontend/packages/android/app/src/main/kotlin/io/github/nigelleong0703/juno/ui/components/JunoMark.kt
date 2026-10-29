package io.github.nigelleong0703.juno.ui.components

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import io.github.nigelleong0703.juno.R

/** The brand mark: Juno's bean on a soft warm wash, floating a few points up and down (the iPhone's JunoMark). */
@Composable
fun JunoMark(height: Dp, modifier: Modifier = Modifier) {
    val bob by rememberInfiniteTransition(label = "mark").animateFloat(
        initialValue = -1f, targetValue = 1f, label = "bob",
        animationSpec = infiniteRepeatable(tween(2200), RepeatMode.Reverse),
    )
    Box(modifier.size(height * 2.6f), contentAlignment = Alignment.Center) {
        Box(
            Modifier.size(height * 2.6f).drawBehind {
                drawCircle(Brush.radialGradient(listOf(Color(0xFFF5C542).copy(alpha = 0.3f), Color.Transparent)))
            },
        )
        Image(
            painterResource(R.drawable.juno_bean), contentDescription = null,
            modifier = Modifier.height(height).graphicsLayer { translationY = bob * height.toPx() * 0.025f },
        )
    }
}
