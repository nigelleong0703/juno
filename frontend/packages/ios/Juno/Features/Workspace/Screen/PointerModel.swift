import CoreGraphics

/// The geometry behind phone mouse control: where the remote cursor is, and how the zoomed view sits on the
/// phone. Pure maths (no UIKit, no web view), so the gesture surface stays thin and this stays testable.
///
/// Three spaces: framebuffer pixels (what the remote computer sees), page points (the web view at zoom 1, where
/// noVNC lays the scaled canvas out) and screen points (what the finger touches): `screen = page * zoom + offset`.
struct PointerModel {
    /// Remote framebuffer size in pixels.
    var fb = CGSize(width: 1, height: 1)
    /// Where noVNC drew the canvas, in page points at zoom 1.
    var canvas = CGRect(x: 0, y: 0, width: 1, height: 1)
    /// The touch surface (= web view) size in points.
    var container = CGSize(width: 1, height: 1)
    /// Cursor position in framebuffer pixels.
    private(set) var cursor = CGPoint.zero
    private(set) var zoom: CGFloat = 1
    /// Page-to-screen translation; never positive, so the picture always covers the surface.
    private(set) var offset = CGPoint.zero

    static let maxZoom: CGFloat = 5

    /// Framebuffer pixels per page point.
    private var pageToFb: CGFloat { fb.width / max(canvas.width, 1) }

    /// First layout (or a remote resolution change) puts the cursor in the middle; later layouts keep it.
    mutating func setLayout(fb: CGSize, canvas: CGRect, container: CGSize) {
        let fresh = self.fb != fb
        self.fb = fb
        self.canvas = canvas
        self.container = container
        if fresh { cursor = CGPoint(x: fb.width / 2, y: fb.height / 2) }
        cursor = clampFb(cursor)
        offset = clampOffset(offset)
    }

    // MARK: Mapping

    func fbPoint(fromScreen p: CGPoint) -> CGPoint {
        let page = CGPoint(x: (p.x - offset.x) / zoom, y: (p.y - offset.y) / zoom)
        return clampFb(CGPoint(x: (page.x - canvas.minX) * pageToFb, y: (page.y - canvas.minY) * pageToFb))
    }

    func screenPoint(fromFb p: CGPoint) -> CGPoint {
        let page = pagePoint(fromFb: p)
        return CGPoint(x: page.x * zoom + offset.x, y: page.y * zoom + offset.y)
    }

    func pagePoint(fromFb p: CGPoint) -> CGPoint {
        CGPoint(x: canvas.minX + p.x / pageToFb, y: canvas.minY + p.y / pageToFb)
    }

    var cursorScreen: CGPoint { screenPoint(fromFb: cursor) }
    var cursorPage: CGPoint { pagePoint(fromFb: cursor) }

    // MARK: Cursor

    /// Finger speed (points/second) to a gain: slow moves are 1:1 for precision, fast flicks cross the screen.
    static func gain(speed: CGFloat) -> CGFloat { 1 + min(max(speed - 150, 0) / 600, 2) }

    /// Trackpad drag: `delta` is the finger's movement in screen points, `speed` its current speed.
    mutating func moveCursor(by delta: CGSize, speed: CGFloat) {
        let g = Self.gain(speed: speed) / (zoom * max(canvas.width / fb.width, 0.0001))
        cursor = clampFb(CGPoint(x: cursor.x + delta.width * g, y: cursor.y + delta.height * g))
    }

    /// The cursor jumps to a framebuffer point (a snapped tap).
    mutating func place(atFb p: CGPoint) { cursor = clampFb(p) }

    /// Direct touch: the cursor jumps to where the finger is.
    mutating func place(atScreen p: CGPoint) { cursor = fbPoint(fromScreen: p) }

    // MARK: View (zoom and pan)

    /// Pinch: scale by `factor`, keeping the page point under `anchor` where it is.
    mutating func zoom(by factor: CGFloat, about anchor: CGPoint) {
        let page = CGPoint(x: (anchor.x - offset.x) / zoom, y: (anchor.y - offset.y) / zoom)
        zoom = min(max(zoom * factor, 1), Self.maxZoom)
        offset = clampOffset(CGPoint(x: anchor.x - page.x * zoom, y: anchor.y - page.y * zoom))
    }

    mutating func pan(by delta: CGSize) {
        offset = clampOffset(CGPoint(x: offset.x + delta.width, y: offset.y + delta.height))
    }

    /// Scroll the zoomed picture so the cursor stays at least `margin` points inside the surface.
    mutating func followCursor(margin: CGFloat = 48) {
        guard zoom > 1 else { return }
        let c = cursorScreen
        var d = CGSize.zero
        if c.x < margin { d.width = margin - c.x } else if c.x > container.width - margin { d.width = container.width - margin - c.x }
        if c.y < margin { d.height = margin - c.y } else if c.y > container.height - margin { d.height = container.height - margin - c.y }
        pan(by: d)
    }

    // MARK: Focus (take-over of one element)

    /// Zoom to a framebuffer rectangle (the element the agent needs the user's hands on) and put the cursor in its middle.
    /// The rectangle fills about 70% of the width (and at most 40% of the height), never zooming past 3x, so the
    /// surroundings stay in view; a rectangle too big to zoom into just keeps the whole picture.
    mutating func focus(on rect: CGRect) {
        guard rect.width > 0, rect.height > 0, canvas.width > 0 else { return }
        let page = CGRect(origin: pagePoint(fromFb: rect.origin), size: CGSize(width: rect.width / pageToFb, height: rect.height / pageToFb))
        let fit = min(container.width * 0.7 / page.width, container.height * 0.4 / page.height)
        zoom = min(max(fit, 1), 3)
        // Page-to-screen translation putting the rectangle's middle in the middle of the surface, clamped to the picture.
        offset = clampOffset(CGPoint(x: container.width / 2 - page.midX * zoom, y: container.height / 2 - page.midY * zoom))
        cursor = clampFb(CGPoint(x: rect.midX, y: rect.midY))
    }

    // MARK: Tap snapping

    /// Direct touch: a tap near (not on) a control lands on the nearest one. `elements` are framebuffer rectangles; one
    /// within `radius` screen points of the touch wins (the closest, then the smallest); a touch that is already on an
    /// element, or has none nearby, keeps its raw point. The snapped point is the nearest point of the element's middle
    /// half, so the click never lands on an edge.
    func snap(_ point: CGPoint, to elements: [CGRect], radius: CGFloat = 24) -> CGPoint {
        let reach = radius / max(zoom * canvas.width / max(fb.width, 1), 0.0001)
        var best: (distance: CGFloat, area: CGFloat, rect: CGRect)?
        for rect in elements where rect.width > 0 && rect.height > 0 {
            let dx = max(rect.minX - point.x, 0, point.x - rect.maxX)
            let dy = max(rect.minY - point.y, 0, point.y - rect.maxY)
            let d = hypot(dx, dy)
            if d == 0 { return point }
            guard d <= reach else { continue }
            let area = rect.width * rect.height
            if best == nil || d < best!.distance - 0.5 || (abs(d - best!.distance) <= 0.5 && area < best!.area) { best = (d, area, rect) }
        }
        guard let rect = best?.rect else { return point }
        let core = rect.insetBy(dx: rect.width / 4, dy: rect.height / 4)
        return clampFb(CGPoint(x: min(max(point.x, core.minX), core.maxX), y: min(max(point.y, core.minY), core.maxY)))
    }

    // MARK: Clamping

    private func clampFb(_ p: CGPoint) -> CGPoint {
        CGPoint(x: min(max(p.x, 0), max(fb.width - 1, 0)), y: min(max(p.y, 0), max(fb.height - 1, 0)))
    }

    private func clampOffset(_ o: CGPoint) -> CGPoint {
        CGPoint(x: min(max(o.x, container.width * (1 - zoom)), 0), y: min(max(o.y, container.height * (1 - zoom)), 0))
    }
}
