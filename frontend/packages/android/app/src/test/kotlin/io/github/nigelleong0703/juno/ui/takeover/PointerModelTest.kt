package io.github.nigelleong0703.juno.ui.agents.takeover

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PointerModelTest {
    /** 1000x500 framebuffer drawn at half size (500x250) at (10, 20) in a 520x290 page. */
    private fun model() = PointerModel().apply { setLayout(Sz(1000f, 500f), Rc(10f, 20f, 500f, 250f), Sz(520f, 290f)) }

    private fun assertPt(x: Float, y: Float, p: Pt, eps: Float = 0.01f) {
        assertEquals(x, p.x, eps); assertEquals(y, p.y, eps)
    }

    @Test fun firstLayoutCentersCursorAndKeepsItAfterwards() {
        val m = model()
        assertPt(500f, 250f, m.cursor)
        m.placeAtFb(Pt(100f, 100f))
        m.setLayout(Sz(1000f, 500f), Rc(10f, 20f, 500f, 250f), Sz(520f, 290f))
        assertPt(100f, 100f, m.cursor)
        m.setLayout(Sz(2000f, 1000f), Rc(10f, 20f, 500f, 250f), Sz(520f, 290f))
        assertPt(1000f, 500f, m.cursor)
    }

    @Test fun mappingRoundTripsAndClamps() {
        val m = model()
        assertPt(110f, 120f, m.screenPoint(Pt(200f, 200f)))
        assertPt(200f, 200f, m.fbPoint(Pt(110f, 120f)))
        assertPt(0f, 0f, m.fbPoint(Pt(-50f, -50f)))
        assertPt(999f, 499f, m.fbPoint(Pt(900f, 900f)))
    }

    @Test fun gainIsOneToOneWhenSlowAndCapsAtThree() {
        assertEquals(1f, PointerModel.gain(100f), 0f)
        assertEquals(1.5f, PointerModel.gain(450f), 0.001f)
        assertEquals(3f, PointerModel.gain(5000f), 0f)
    }

    @Test fun trackpadDragMovesByFramebufferScale() {
        val m = model()
        m.moveCursor(Pt(10f, 0f), 0f)
        assertPt(520f, 250f, m.cursor)  // 10 points = 20 framebuffer pixels at half size
        m.moveCursor(Pt(-10000f, 0f), 0f)
        assertEquals(0f, m.cursor.x, 0f)
    }

    @Test fun zoomKeepsAnchorAndClampsToLimitsAndPan() {
        val m = model()
        m.zoomBy(2f, Pt(260f, 145f))
        assertEquals(2f, m.zoom, 0f)
        assertPt(260f, 145f, m.screenPoint(m.fbPoint(Pt(260f, 145f))))
        m.zoomBy(100f, Pt(0f, 0f))
        assertEquals(PointerModel.MAX_ZOOM, m.zoom, 0f)
        m.pan(Pt(10000f, 10000f))
        assertPt(0f, 0f, m.offset)
        m.pan(Pt(-10000f, -10000f))
        assertPt(520f * (1 - 5f), 290f * (1 - 5f), m.offset)
        m.zoomBy(0.001f, Pt(0f, 0f))
        assertEquals(1f, m.zoom, 0f)
        assertPt(0f, 0f, m.offset)
    }

    @Test fun followCursorOnlyWhenZoomed() {
        val m = model()
        m.followCursor()
        assertPt(0f, 0f, m.offset)
        m.zoomBy(3f, Pt(0f, 0f))
        m.placeAtFb(Pt(500f, 250f))
        m.followCursor()
        val c = m.cursorScreen
        assertTrue(c.x <= m.container.w - 48f + 0.01f && c.y <= m.container.h - 48f + 0.01f)
    }

    @Test fun focusZoomsToRectCapsAtThreeAndCentersCursor() {
        val m = model()
        m.focusOn(Rc(400f, 200f, 100f, 50f))
        assertEquals(3f, m.zoom, 0f)
        assertPt(450f, 225f, m.cursor)
        val big = model()
        big.focusOn(Rc(0f, 0f, 1000f, 500f))
        assertEquals(1f, big.zoom, 0f)
        val none = model()
        none.focusOn(Rc(10f, 10f, 0f, 0f))
        assertEquals(1f, none.zoom, 0f)
    }

    @Test fun snapLandsInMiddleHalfOfNearbyElementAndKeepsRawOtherwise() {
        val m = model()
        val button = Rc(100f, 100f, 80f, 40f)
        // On the element: untouched.
        assertPt(120f, 110f, m.snap(Pt(120f, 110f), listOf(button)))
        // Just outside (10 fb px = 5 points): pulled into the middle half (x 120..160, y 110..130).
        assertPt(120f, 110f, m.snap(Pt(95f, 105f), listOf(button)))
        // Far away: raw.
        assertPt(400f, 400f, m.snap(Pt(400f, 400f), listOf(button)))
        // The closer of two elements wins.
        val far = Rc(300f, 100f, 20f, 20f)
        assertPt(120f, 110f, m.snap(Pt(95f, 105f), listOf(far, button)))
    }

    @Test fun snapReachShrinksWithZoom() {
        val m = model()
        val el = Rc(100f, 100f, 20f, 20f)
        // 40 fb px away = 20 points at zoom 1 (inside the 24-point reach).
        assertTrue(m.snap(Pt(160f, 110f), listOf(el)) != Pt(160f, 110f))
        m.zoomBy(3f, Pt(0f, 0f))
        // At 3x the same 40 fb px is 60 points: out of reach.
        assertEquals(Pt(160f, 110f), m.snap(Pt(160f, 110f), listOf(el)))
    }

    @Test fun scrollNotchesFollowNaturalScrollingAndKeepTheRemainder() {
        val s = ScrollNotches()
        assertEquals(emptyList<Int>(), s.feed(0f, 20f))
        assertEquals(listOf(3), s.feed(0f, 10f))      // fingers down: wheel up
        assertEquals(listOf(4, 4), s.feed(0f, -60f))   // 4 left over + 60 up: two notches down
        assertEquals(listOf(5), s.feed(26f, 0f))
        assertEquals(listOf(6), s.feed(-52f, 0f).take(1))
        s.reset()
        assertEquals(emptyList<Int>(), s.feed(25f, 25f))
    }

    @Test fun textRolesAreCaseInsensitiveAndNullSafe() {
        assertTrue(isTextRole("TextBox"))
        assertTrue(isTextRole("password"))
        assertFalse(isTextRole("button"))
        assertFalse(isTextRole(null))
    }
}
