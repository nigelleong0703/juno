package io.github.nigelleong0703.juno.ui.shell

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.input.pointer.pointerInput
import kotlin.math.abs
import kotlin.math.min
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import kotlinx.coroutines.launch

/** iOS `DrawerController`: the drawer is 75% of the screen wide and the page slides right to show it. */
private const val DRAWER_SHARE = 0.75f
/** The slid page's corners (iOS follows the device corners; a card radius reads the same on Android). */
private val PAGE_CORNER = 55.dp
/** iOS `page.layer.shadowRadius` / `shadowOffset` (-6 pt, leading edge), opacity 0.10 * p. */
private val PAGE_SHADOW_RADIUS = 12.dp
private val PAGE_SHADOW_DX = (-6).dp
private val FLING = 300.dp
private const val SHOW_AT = 0.12f
private const val HIDE_AT = 0.88f

/**
 * The ☰ drawer as one container (iOS DrawerShell): [sidebar] sits underneath, scaled 0.97 and dimmed while it is back,
 * and [page] slides right over it. A drag moves the page 1:1; on release a fling decides, else the position (open once
 * past 12%, closed below 88%). [open] is the source of truth, so the ☰ button and sidebar rows animate the same way.
 * [canOpenFrom] gets the x where the drag began (px) and says whether a swipe may open the drawer from there.
 */
@Composable
fun Drawer(
    open: Boolean,
    onOpenChange: (Boolean) -> Unit,
    canOpenFrom: (startX: Float) -> Boolean,
    sidebar: @Composable () -> Unit,
    page: @Composable () -> Unit,
) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val density = LocalDensity.current
        val fullPx = with(density) { maxWidth.toPx() }
        val widthDp = maxWidth * DRAWER_SHARE
        val widthPx = fullPx * DRAWER_SHARE
        val progress = remember { Animatable(if (open) 1f else 0f) }
        val scope = rememberCoroutineScope()
        val isOpen by rememberUpdatedState(open)
        val setOpen by rememberUpdatedState(onOpenChange)
        val mayOpen by rememberUpdatedState(canOpenFrom)
        val flingPx = with(density) { FLING.toPx() }
        val slop = LocalViewConfiguration.current.touchSlop

        // The world changed (☰, a row, the pan's commit): move the page there.
        LaunchedEffect(open) {
            val target = if (open) 1f else 0f
            if (progress.value != target) progress.animateTo(target, drawerSpring())
        }

        val p = progress.value
        val canvas = JunoTheme.colors.canvas
        val canvasArgb = canvas.toArgb()
        val cornerPx = with(density) { PAGE_CORNER.toPx() }
        Box(
            Modifier.fillMaxSize().background(canvas).pointerInput(widthPx) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    val tracker = VelocityTracker()
                    tracker.addPosition(down.uptimeMillis, down.position)
                    val startP = progress.value
                    val startX = down.position.x
                    var dragX = 0f
                    var dragY = 0f
                    var decided = false
                    var moving = false
                    while (true) {
                        val event = awaitPointerEvent()
                        val change = event.changes.firstOrNull { it.id == down.id } ?: break
                        if (!change.pressed) break
                        val delta = change.positionChange()
                        dragX += delta.x
                        dragY += delta.y
                        if (!decided && (abs(dragX) > slop || abs(dragY) > slop)) {
                            decided = true
                            // Horizontal only (iOS: |vx| > 1.3 |vy|); right opens, left closes.
                            moving = abs(dragX) > abs(dragY) * 1.3f &&
                                (if (isOpen) dragX < 0f else dragX > 0f && mayOpen(startX))
                            if (!moving) break
                        }
                        if (moving) {
                            change.consume()
                            tracker.addPosition(change.uptimeMillis, change.position)
                            val to = (startP + dragX / widthPx).coerceIn(0f, 1f)
                            scope.launch { progress.snapTo(to) }
                        }
                    }
                    if (moving) {
                        val vx = tracker.calculateVelocity().x
                        val shouldOpen = if (abs(vx) > flingPx) vx > 0f
                        else progress.value >= (if (isOpen) HIDE_AT else SHOW_AT)
                        setOpen(shouldOpen)
                        scope.launch { progress.animateTo(if (shouldOpen) 1f else 0f, drawerSpring()) }
                    }
                }
            },
        ) {
            // Sidebar: sits back at 0.97 (scaled about the screen centre, iOS dx correction). Not touchable until it is
            // mostly open (iOS: isUserInteractionEnabled = p > 0.5); the consumed touches still reach the drawer pan.
            val scale = 0.97f + 0.03f * p
            Box(
                Modifier
                    .width(widthDp)
                    .fillMaxHeight()
                    .graphicsLayer {
                        scaleX = scale
                        scaleY = scale
                        translationX = (fullPx / 2f - widthPx / 2f) * (1f - scale)
                    }
                    .background(canvas)
                    .then(if (p > 0.5f) Modifier else Modifier.pointerInput(Unit) {
                        awaitPointerEventScope {
                            while (true) awaitPointerEvent(PointerEventPass.Initial).changes.forEach { it.consume() }
                        }
                    }),
            ) { sidebar() }
            // Full screen and never scaled, so the canvas the shrunken sidebar uncovers is dimmed with it (iOS sidebarDim).
            if (p < 1f) Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.35f * (1f - p))))

            // Leading-edge shadow on the rounded page shape, drawn outside the clipped page (iOS page.layer.shadow*).
            if (p > 0f) Box(
                Modifier.fillMaxSize().graphicsLayer { translationX = p * widthPx }.drawBehind {
                    val paint = android.graphics.Paint().apply {
                        isAntiAlias = true
                        color = canvasArgb
                        setShadowLayer(
                            PAGE_SHADOW_RADIUS.toPx(), PAGE_SHADOW_DX.toPx(), 0f,
                            android.graphics.Color.argb((0.10f * p * 255).toInt(), 0, 0, 0),
                        )
                    }
                    drawContext.canvas.nativeCanvas.drawRoundRect(0f, 0f, size.width, size.height, cornerPx, cornerPx, paint)
                },
            )

            // Page: slides right, corners round to the device-like 55 dp while it moves (iOS cornerRadius = 55 * min(1, 4p)).
            Box(
                Modifier
                    .fillMaxSize()
                    .graphicsLayer {
                        translationX = p * widthPx
                        shape = RoundedCornerShape(PAGE_CORNER * min(1f, p * 4f))
                        clip = p > 0f
                    }
                    .background(canvas),
            ) {
                page()
                if (p > 0f) {
                    // The washed-out page while open (iOS scrim: canvas at 0.55 p, same rounded shape); a tap closes the drawer.
                    Box(
                        Modifier
                            .fillMaxSize()
                            .background(canvas.copy(alpha = 0.55f * p))
                            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { setOpen(false) },
                    )
                }
            }
        }
    }
}

private fun drawerSpring() = spring<Float>(dampingRatio = 0.92f, stiffness = 224f)
