package io.github.nigelleong0703.juno.ui.chat

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.horizontalDrag
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlinx.coroutines.launch

/** Past this drag (dp) the reply is armed, with a light tick; releasing there replies (iOS `SwipeToReply`, 60 pt). */
private const val REPLY_THRESHOLD_DP = 60f

/**
 * Drag a message to the right: the reply arrow fades in behind it, a tick at the threshold, release to reply, spring back.
 * Only a rightward, mostly horizontal drag starts it, so it never fights the list's vertical scroll.
 */
@Composable
fun SwipeToReply(onReply: () -> Unit, content: @Composable () -> Unit) {
    val c = JunoTheme.colors
    val density = LocalDensity.current
    val haptic = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val dx = remember { Animatable(0f) }
    val threshold = with(density) { REPLY_THRESHOLD_DP.dp.toPx() }
    val progress = (dx.value / threshold).coerceIn(0f, 1f)
    Box(
        Modifier.pointerInput(Unit) {
            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false)
                var crossed = false
                var decided = false
                var dragX = 0f
                var dragY = 0f
                horizontalDrag(down.id) { change ->
                    val delta = change.positionChange()
                    // Only a clearly horizontal, rightward move claims the gesture; anything else is left to the list.
                    if (!decided) {
                        dragX += delta.x; dragY += abs(delta.y)
                        decided = dragX > 24f && dragX > dragY * 1.5f
                    }
                    if (decided) {
                        change.consume()
                        val w = (dx.value + delta.x).coerceAtLeast(0f)
                        val shown = if (w < threshold) w else threshold + (w - threshold) * 0.25f
                        scope.launch { dx.snapTo(shown) }
                        if (w >= threshold && !crossed) { crossed = true; haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove) }
                        if (w < threshold) crossed = false
                    }
                }
                if (crossed) onReply()
                scope.launch { dx.animateTo(0f, spring(dampingRatio = 0.8f, stiffness = 400f)) }
            }
        },
    ) {
        Icon(
            JunoIcons.Reply, "Reply", tint = c.fgMuted,
            modifier = Modifier.align(Alignment.CenterStart).alpha(progress).size(32.dp).clip(CircleShape).background(c.muted).padding(7.dp)
                .graphicsLayer { scaleX = 0.6f + 0.4f * progress; scaleY = 0.6f + 0.4f * progress },
        )
        Box(Modifier.offset { IntOffset(dx.value.roundToInt(), 0) }) { content() }
    }
}
