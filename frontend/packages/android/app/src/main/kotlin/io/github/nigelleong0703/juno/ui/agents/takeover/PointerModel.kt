package io.github.nigelleong0703.juno.ui.agents.takeover

import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

data class Pt(val x: Float, val y: Float) {
    companion object { val Zero = Pt(0f, 0f) }
}

data class Sz(val w: Float, val h: Float)

data class Rc(val x: Float, val y: Float, val w: Float, val h: Float) {
    val minX get() = x
    val minY get() = y
    val maxX get() = x + w
    val maxY get() = y + h
    val midX get() = x + w / 2
    val midY get() = y + h / 2
    fun inset(dx: Float, dy: Float) = Rc(x + dx, y + dy, w - 2 * dx, h - 2 * dy)
}

/**
 * The geometry behind phone mouse control (iOS `PointerModel`): where the remote cursor is, and how the zoomed view
 * sits on the phone. Pure maths (no Android, no web view), so the gesture surface stays thin and this stays testable.
 *
 * Three spaces: framebuffer pixels (what the remote computer sees), page points (the web view at zoom 1, where
 * noVNC lays the scaled canvas out) and screen points (what the finger touches): `screen = page * zoom + offset`.
 * Page and screen points are CSS px = dp.
 */
class PointerModel {
    /** Remote framebuffer size in pixels. */
    var fb = Sz(1f, 1f); private set
    /** Where noVNC drew the canvas, in page points at zoom 1. */
    var canvas = Rc(0f, 0f, 1f, 1f); private set
    /** The touch surface (= web view) size in points. */
    var container = Sz(1f, 1f); private set
    /** Cursor position in framebuffer pixels. */
    var cursor = Pt.Zero; private set
    var zoom = 1f; private set
    /** Page-to-screen translation; never positive, so the picture always covers the surface. */
    var offset = Pt.Zero; private set

    /** Framebuffer pixels per page point. */
    private val pageToFb get() = fb.w / max(canvas.w, 1f)

    /** First layout (or a remote resolution change) puts the cursor in the middle; later layouts keep it. */
    fun setLayout(fb: Sz, canvas: Rc, container: Sz) {
        val fresh = this.fb != fb
        this.fb = fb
        this.canvas = canvas
        this.container = container
        if (fresh) cursor = Pt(fb.w / 2, fb.h / 2)
        cursor = clampFb(cursor)
        offset = clampOffset(offset)
    }

    // Mapping

    fun fbPoint(fromScreen: Pt): Pt {
        val px = (fromScreen.x - offset.x) / zoom
        val py = (fromScreen.y - offset.y) / zoom
        return clampFb(Pt((px - canvas.minX) * pageToFb, (py - canvas.minY) * pageToFb))
    }

    fun pagePoint(fromFb: Pt) = Pt(canvas.minX + fromFb.x / pageToFb, canvas.minY + fromFb.y / pageToFb)

    fun screenPoint(fromFb: Pt): Pt {
        val page = pagePoint(fromFb)
        return Pt(page.x * zoom + offset.x, page.y * zoom + offset.y)
    }

    val cursorScreen get() = screenPoint(cursor)
    val cursorPage get() = pagePoint(cursor)

    // Cursor

    /** Trackpad drag: [delta] is the finger's movement in screen points, [speed] its current speed (points/second). */
    fun moveCursor(delta: Pt, speed: Float) {
        val g = gain(speed) / (zoom * max(canvas.w / fb.w, 0.0001f))
        cursor = clampFb(Pt(cursor.x + delta.x * g, cursor.y + delta.y * g))
    }

    /** The cursor jumps to a framebuffer point (a snapped tap). */
    fun placeAtFb(p: Pt) { cursor = clampFb(p) }

    /** Direct touch: the cursor jumps to where the finger is. */
    fun placeAtScreen(p: Pt) { cursor = fbPoint(p) }

    // View (zoom and pan)

    /** Pinch: scale by [factor], keeping the page point under [anchor] where it is. */
    fun zoomBy(factor: Float, anchor: Pt) {
        val px = (anchor.x - offset.x) / zoom
        val py = (anchor.y - offset.y) / zoom
        zoom = min(max(zoom * factor, 1f), MAX_ZOOM)
        offset = clampOffset(Pt(anchor.x - px * zoom, anchor.y - py * zoom))
    }

    fun pan(delta: Pt) { offset = clampOffset(Pt(offset.x + delta.x, offset.y + delta.y)) }

    /** Scroll the zoomed picture so the cursor stays at least [margin] points inside the surface. */
    fun followCursor(margin: Float = 48f) {
        if (zoom <= 1f) return
        val c = cursorScreen
        var dx = 0f
        var dy = 0f
        if (c.x < margin) dx = margin - c.x else if (c.x > container.w - margin) dx = container.w - margin - c.x
        if (c.y < margin) dy = margin - c.y else if (c.y > container.h - margin) dy = container.h - margin - c.y
        pan(Pt(dx, dy))
    }

    // Focus (take-over of one element)

    /**
     * Zoom to a framebuffer rectangle (the element the agent needs the user's hands on) and put the cursor in its
     * middle. The rectangle fills about 70% of the width (and at most 40% of the height), never zooming past 3x, so
     * the surroundings stay in view; a rectangle too big to zoom into just keeps the whole picture.
     */
    fun focusOn(rect: Rc) {
        if (rect.w <= 0f || rect.h <= 0f || canvas.w <= 0f) return
        val origin = pagePoint(Pt(rect.x, rect.y))
        val pw = rect.w / pageToFb
        val ph = rect.h / pageToFb
        val fit = min(container.w * 0.7f / pw, container.h * 0.4f / ph)
        zoom = min(max(fit, 1f), 3f)
        offset = clampOffset(Pt(container.w / 2 - (origin.x + pw / 2) * zoom, container.h / 2 - (origin.y + ph / 2) * zoom))
        cursor = clampFb(Pt(rect.midX, rect.midY))
    }

    // Tap snapping

    /**
     * Direct touch: a tap near (not on) a control lands on the nearest one. [elements] are framebuffer rectangles; one
     * within [radius] screen points of the touch wins (the closest, then the smallest); a touch already on an element,
     * or with none nearby, keeps its raw point. The snapped point is the nearest point of the element's middle half,
     * so the click never lands on an edge.
     */
    fun snap(point: Pt, elements: List<Rc>, radius: Float = 24f): Pt {
        val reach = radius / max(zoom * canvas.w / max(fb.w, 1f), 0.0001f)
        var best: Rc? = null
        var bestDistance = 0f
        var bestArea = 0f
        for (rect in elements) {
            if (rect.w <= 0f || rect.h <= 0f) continue
            val dx = max(max(rect.minX - point.x, 0f), point.x - rect.maxX)
            val dy = max(max(rect.minY - point.y, 0f), point.y - rect.maxY)
            val d = hypot(dx, dy)
            if (d == 0f) return point
            if (d > reach) continue
            val area = rect.w * rect.h
            if (best == null || d < bestDistance - 0.5f || (abs(d - bestDistance) <= 0.5f && area < bestArea)) {
                best = rect; bestDistance = d; bestArea = area
            }
        }
        val rect = best ?: return point
        val core = rect.inset(rect.w / 4, rect.h / 4)
        return clampFb(Pt(min(max(point.x, core.minX), core.maxX), min(max(point.y, core.minY), core.maxY)))
    }

    // Clamping

    private fun clampFb(p: Pt) = Pt(min(max(p.x, 0f), max(fb.w - 1, 0f)), min(max(p.y, 0f), max(fb.h - 1, 0f)))

    private fun clampOffset(o: Pt) = Pt(min(max(o.x, container.w * (1 - zoom)), 0f), min(max(o.y, container.h * (1 - zoom)), 0f))

    companion object {
        const val MAX_ZOOM = 5f

        /** Finger speed (points/second) to a gain: slow moves are 1:1 for precision, fast flicks cross the screen. */
        fun gain(speed: Float): Float = 1 + min(max(speed - 150f, 0f) / 600f, 2f)
    }
}

/**
 * Two-finger scrolling in wheel notches (iOS `PointerSurface.scroll`): finger movement accumulates and one notch goes
 * out per [STEP] points. Natural scrolling: the page follows the fingers, so dragging up scrolls down.
 * Wheel bits are RFB buttons: 3 up, 4 down, 5 left, 6 right.
 */
class ScrollNotches {
    private var rx = 0f
    private var ry = 0f

    fun reset() { rx = 0f; ry = 0f }

    fun feed(dx: Float, dy: Float): List<Int> {
        rx += dx; ry += dy
        val out = ArrayList<Int>()
        while (abs(ry) >= STEP) { out += if (ry > 0) 3 else 4; ry -= if (ry > 0) STEP else -STEP }
        while (abs(rx) >= STEP) { out += if (rx > 0) 5 else 6; rx -= if (rx > 0) STEP else -STEP }
        return out
    }

    companion object { const val STEP = 26f }
}

/** Whether a focused element's role is a text field (the keyboard comes up for it on entry; iOS `isTextRole`). */
fun isTextRole(role: String?): Boolean = role?.lowercase() in TEXT_ROLES

private val TEXT_ROLES = setOf("textbox", "searchbox", "combobox", "textfield", "text field", "input", "textarea", "password", "spinbutton")
