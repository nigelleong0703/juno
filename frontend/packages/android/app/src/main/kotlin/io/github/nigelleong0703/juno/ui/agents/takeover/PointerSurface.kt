package io.github.nigelleong0703.juno.ui.agents.takeover

import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import android.os.SystemClock
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.PointerEvent
import androidx.compose.ui.input.pointer.PointerInputChange
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max

/**
 * The touch layer over the live screen: turns finger gestures into mouse input on the remote computer (iOS `PointerSurface`).
 *
 * Trackpad mode (default): the finger moves a visible cursor, it does not point at things.
 *   drag = move cursor (faster flicks go further) · tap = left click at the cursor · tap twice = double click
 *   tap then hold and drag = press-and-drag (select, move) · two-finger tap = right click
 *   two-finger drag = scroll · pinch = zoom (the view follows the cursor to the edges)
 * Direct mode: tap where you touch (a tap near a control snaps to it, see [elements]). drag = pan the zoomed picture.
 * Both modes: press and hold one finger (half a second, without moving) = right click.
 */
@Composable
fun PointerSurface(
    control: ScreenControl,
    direct: Boolean,
    modifier: Modifier = Modifier,
    /** A framebuffer rectangle to zoom to and put the cursor in (a take-over request's focus); applied once per value. */
    focus: Rc? = null,
    /** Tap targets in the pixels of [elementsSize] (GET screens/:id/elements); empty = taps are raw. */
    elements: List<Rc> = emptyList(),
    elementsSize: Sz = Sz(0f, 0f),
    /** A click went out (the page may have changed: refresh the tap targets). */
    onClick: () -> Unit = {},
) {
    val haptic = LocalHapticFeedback.current
    val driver = remember(control) { PointerDriver(control) }
    driver.haptic = haptic
    driver.onClick = onClick
    SideEffect {
        driver.elements = elements
        driver.elementsSize = elementsSize
        driver.setDirect(direct)
        driver.setFocus(focus)
    }
    DisposableEffect(driver) {
        control.onLayout = { fb, canvas, container -> driver.layout(fb, canvas, container) }
        // The page reported its layout when it connected, before this surface existed: ask again.
        control.requestLayout()
        onDispose { control.onLayout = null }
    }
    Box(modifier.pointerInput(driver) { gestures(driver) })
}

/** Gesture state machine; every position handed to [driver] is in dp (= CSS px of the page). */
private suspend fun PointerInputScope.gestures(driver: PointerDriver) {
    var lastTapUp = 0L
    var lastTapPos = Offset.Zero
    val slop = viewConfiguration.touchSlop
    val dp = density
    fun Offset.pt() = Pt(x / dp, y / dp)

    awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false)
        down.consume()
        val start = down.position
        val t0 = down.uptimeMillis
        // Touch again soon after a tap, near it: hold = press-and-drag, release = the second click of a double tap.
        val followUp = t0 - lastTapUp < DOUBLE_TAP_MS && (start - lastTapPos).getDistance() < slop * 6
        val holdAt = t0 + if (followUp) HOLD_DRAG_MS else RIGHT_HOLD_MS
        var mode = Mode.Undecided
        val tracker = VelocityTracker()
        tracker.addPosition(t0, start)
        var last = start
        var twoStart = 0L
        var twoCentroid0 = Offset.Zero
        var twoCentroid = Offset.Zero
        var twoSpread = 1f
        var two = TwoFinger.Undecided
        val notches = ScrollNotches()

        while (true) {
            val event: PointerEvent? = if (mode != Mode.Undecided) awaitPointerEvent()
            else withTimeoutOrNull(max(holdAt - SystemClock.uptimeMillis(), 1L)) { awaitPointerEvent() }
            if (event == null) {
                // Held still long enough.
                if (followUp) { mode = Mode.HoldDrag; driver.holdBegin(last.pt()) }
                else { mode = Mode.Done; driver.rightClickAt(last.pt()) }
                continue
            }
            val pressed = event.changes.filter { it.pressed }
            val primary = event.changes.firstOrNull { it.id == down.id } ?: event.changes.first()
            val now = event.changes.first().uptimeMillis

            // A second finger turns an undecided gesture into a two-finger one.
            if (mode == Mode.Undecided && pressed.size >= 2) {
                mode = Mode.TwoFinger
                twoStart = now
                twoCentroid = centroid(pressed); twoCentroid0 = twoCentroid; twoSpread = spread(pressed, twoCentroid)
                notches.reset()
                event.changes.forEach { it.consume() }
                continue
            }

            when (mode) {
                Mode.Undecided -> {
                    primary.consume()
                    if (!primary.pressed) {
                        // Release without moving: a tap.
                        driver.tap(primary.position.pt())
                        lastTapUp = primary.uptimeMillis; lastTapPos = primary.position
                        return@awaitEachGesture
                    }
                    tracker.addPosition(primary.uptimeMillis, primary.position)
                    last = primary.position
                    if ((primary.position - start).getDistance() > slop) {
                        if (followUp) { mode = Mode.HoldDrag; driver.holdBegin(start.pt()); driver.holdMove(primary.position.pt()) }
                        else { mode = Mode.Drag; last = start; driver.drag(primary.position.pt() - start.pt(), speed(tracker)); last = primary.position }
                    }
                }
                Mode.Drag -> {
                    primary.consume()
                    if (!primary.pressed) return@awaitEachGesture
                    tracker.addPosition(primary.uptimeMillis, primary.position)
                    driver.drag(primary.position.pt() - last.pt(), speed(tracker))
                    last = primary.position
                }
                Mode.HoldDrag -> {
                    primary.consume()
                    if (!primary.pressed) { driver.holdEnd(); return@awaitEachGesture }
                    driver.holdMove(primary.position.pt())
                }
                Mode.TwoFinger -> {
                    event.changes.forEach { it.consume() }
                    if (pressed.size >= 2) {
                        val c = centroid(pressed)
                        val s = spread(pressed, c)
                        val d = c - twoCentroid
                        val factor = if (twoSpread > 0f) s / twoSpread else 1f
                        if (two == TwoFinger.Undecided) {
                            // Whichever of scroll (14 pt of travel) or pinch (6% spread change) shows first wins.
                            if ((c - twoCentroid0).getDistance() / dp > 14f) two = TwoFinger.Scroll
                            else if (abs(factor - 1f) > 0.06f) two = TwoFinger.Zoom
                        }
                        when (two) {
                            TwoFinger.Scroll -> driver.scroll(d.pt(), c.pt(), notches)
                            TwoFinger.Zoom -> { driver.pinch(factor, c.pt()); driver.panBy(d.pt()); twoSpread = s }
                            TwoFinger.Undecided -> {}
                        }
                        twoCentroid = c
                    }
                    if (pressed.isEmpty()) {
                        // Both fingers up quickly without travelling or pinching: right click.
                        if (two == TwoFinger.Undecided && now - twoStart < TWO_FINGER_TAP_MS) driver.rightClickAt(twoCentroid.pt())
                        return@awaitEachGesture
                    }
                }
                Mode.Done -> {
                    event.changes.forEach { it.consume() }
                    if (pressed.isEmpty()) return@awaitEachGesture
                }
            }
        }
    }
}

private enum class Mode { Undecided, Drag, HoldDrag, TwoFinger, Done }

private enum class TwoFinger { Undecided, Scroll, Zoom }

private fun speed(tracker: VelocityTracker): Float = tracker.calculateVelocity().let { hypot(it.x, it.y) }

private fun centroid(changes: List<PointerInputChange>): Offset =
    changes.fold(Offset.Zero) { a, c -> a + c.position } / changes.size.toFloat()

private fun spread(changes: List<PointerInputChange>, centroid: Offset): Float =
    changes.map { (it.position - centroid).getDistance() }.average().toFloat()

private operator fun Pt.minus(o: Pt) = Pt(x - o.x, y - o.y)

private const val DOUBLE_TAP_MS = 300L
private const val HOLD_DRAG_MS = 120L
private const val RIGHT_HOLD_MS = 500L
private const val TWO_FINGER_TAP_MS = 400L

/** Turns recognised gestures into model changes and remote input; the Android twin of the iOS `Coordinator`. */
internal class PointerDriver(private val control: ScreenControl) {
    var haptic: HapticFeedback? = null
    var onClick: () -> Unit = {}
    var elements: List<Rc> = emptyList()
    var elementsSize = Sz(0f, 0f)
    private val model = PointerModel()
    private var direct = false
    private var buttons = 0
    private var lastHold = Pt.Zero
    private var pendingFocus: Rc? = null
    private var appliedFocus: Rc? = null

    fun setDirect(on: Boolean) {
        if (on == direct) return
        direct = on
        show()
    }

    fun layout(fb: Sz, canvas: Rc, container: Sz) {
        model.setLayout(fb, canvas, container)
        applyFocus()
        show()
    }

    fun setFocus(rect: Rc?) {
        if (rect == null || rect == appliedFocus) return
        pendingFocus = rect
        applyFocus()
    }

    /** Waits for the first layout (the page reports it once connected), then zooms once. */
    private fun applyFocus() {
        val rect = pendingFocus ?: return
        if (model.fb.w <= 1f) return
        pendingFocus = null; appliedFocus = rect
        model.focusOn(rect)
        show(); send()
    }

    /** Direct touch: the touch point in framebuffer pixels, moved onto a control close to it. */
    private fun snapped(atScreen: Pt): Pt {
        val raw = model.fbPoint(atScreen)
        if (elements.isEmpty()) return raw
        val k = if (elementsSize.w > 0f) model.fb.w / elementsSize.w else 1f
        return model.snap(raw, elements.map { Rc(it.x * k, it.y * k, it.w * k, it.h * k) })
    }

    /** Cursor and zoom to the page; the cursor only shows in trackpad mode. */
    private fun show() = control.view(model.zoom, model.offset, model.cursorPage, !direct)

    private fun send() = control.pointer(model.cursor, buttons)

    private fun click(mask: Int) {
        haptic?.performHapticFeedback(HapticFeedbackType.TextHandleMove)
        control.pointer(model.cursor, mask)
        control.pointer(model.cursor, 0)
        onClick()
    }

    fun tap(p: Pt) {
        if (direct) { model.placeAtFb(snapped(p)); show() }
        click(1)
    }

    /** Right click at the cursor (trackpad) or under the finger (direct). */
    fun rightClickAt(p: Pt) {
        if (direct) { model.placeAtFb(snapped(p)); show() }
        click(4)
    }

    fun drag(delta: Pt, speed: Float) {
        if (direct) model.pan(delta)
        else {
            model.moveCursor(delta, speed)
            model.followCursor()
            send()
        }
        show()
    }

    /** Tap, then touch again and hold: the button goes down and stays down while the finger moves. */
    fun holdBegin(p: Pt) {
        if (direct) model.placeAtScreen(p)
        lastHold = p
        buttons = 1
        haptic?.performHapticFeedback(HapticFeedbackType.TextHandleMove)
        show(); send()
    }

    fun holdMove(p: Pt) {
        if (direct) model.placeAtScreen(p)
        else {
            model.moveCursor(Pt(p.x - lastHold.x, p.y - lastHold.y), 0f)
            model.followCursor()
        }
        lastHold = p
        show(); send()
    }

    fun holdEnd() { buttons = 0; send() }

    fun scroll(delta: Pt, at: Pt, notches: ScrollNotches) {
        if (direct) { model.placeAtScreen(at); show() }
        for (bit in notches.feed(delta.x, delta.y)) control.wheel(model.cursor, bit)
    }

    fun pinch(factor: Float, anchor: Pt) {
        model.zoomBy(factor, if (direct) anchor else model.cursorScreen)
        show()
    }

    fun panBy(delta: Pt) { model.pan(delta); show() }
}
