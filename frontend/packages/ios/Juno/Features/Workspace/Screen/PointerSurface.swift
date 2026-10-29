import SwiftUI
import UIKit

/// The touch layer over the live screen: turns finger gestures into mouse input on the remote computer.
///
/// Trackpad mode (default): the finger moves a visible cursor, it does not point at things.
///   drag = move cursor (faster flicks go further) · tap = left click at the cursor · tap twice = double click
///   tap then hold and drag = press-and-drag (select, move) · two-finger tap = right click
///   two-finger drag = scroll · pinch = zoom (the view follows the cursor to the edges)
/// Direct mode: tap where you touch (a tap near a control snaps to it, see `elements`). drag = pan the zoomed picture ·
/// hold and drag = press-and-drag, the rest as above.
/// Both modes: press and hold one finger (half a second, without moving) = right click, as in Windows App.
struct PointerSurface: UIViewRepresentable {
    var control: ScreenControl
    var direct: Bool
    /// A framebuffer rectangle to zoom to and put the cursor in (a take-over request's focus); applied once per value.
    var focus: CGRect?
    /// Tap targets in the pixels of `elementsSize` (GET /v1/screens/:id/elements); empty = taps are raw.
    var elements: [CGRect] = []
    var elementsSize: CGSize = .zero
    /// A click went out (the page may have changed: refresh the tap targets).
    var onClick: () -> Void = {}

    func makeCoordinator() -> Coordinator { Coordinator(control: control) }

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .clear
        view.isMultipleTouchEnabled = true
        let c = context.coordinator
        c.view = view
        func add<G: UIGestureRecognizer>(_ g: G, _ action: Selector) -> G {
            g.addTarget(c, action: action); g.delegate = c; view.addGestureRecognizer(g); return g
        }
        let rightClick = add(UITapGestureRecognizer(), #selector(Coordinator.rightClick(_:)))
        rightClick.numberOfTouchesRequired = 2
        let tap = add(UITapGestureRecognizer(), #selector(Coordinator.tap(_:)))
        tap.require(toFail: rightClick)
        let rightHold = add(UILongPressGestureRecognizer(), #selector(Coordinator.rightHold(_:)))
        rightHold.minimumPressDuration = 0.5
        rightHold.allowableMovement = 10
        let hold = add(UILongPressGestureRecognizer(), #selector(Coordinator.hold(_:)))
        hold.numberOfTapsRequired = 1
        hold.minimumPressDuration = 0.12
        hold.allowableMovement = 1000
        let drag = add(UIPanGestureRecognizer(), #selector(Coordinator.drag(_:)))
        drag.maximumNumberOfTouches = 1
        let scroll = add(UIPanGestureRecognizer(), #selector(Coordinator.scroll(_:)))
        scroll.minimumNumberOfTouches = 2
        scroll.maximumNumberOfTouches = 2
        _ = add(UIPinchGestureRecognizer(), #selector(Coordinator.pinch(_:)))
        c.control.onLayout = { [weak c] fb, canvas, container in c?.layout(fb, canvas, container) }
        // The page reported its layout when it connected, before this surface existed: ask again.
        DispatchQueue.main.async { [weak control] in control?.requestLayout() }
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        let c = context.coordinator
        c.control = control
        c.elements = elements
        c.elementsSize = elementsSize
        c.onClick = onClick
        c.setDirect(direct)
        c.setFocus(focus)
    }

    static func dismantleUIView(_ view: UIView, coordinator: Coordinator) { coordinator.control.onLayout = nil }

    @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var control: ScreenControl
        var elements: [CGRect] = []
        var elementsSize = CGSize.zero
        var onClick: () -> Void = {}
        private var pendingFocus: CGRect?
        private var appliedFocus: CGRect?
        private var holdActive = false
        private var holdEndedAt = Date.distantPast
        weak var view: UIView?
        private var model = PointerModel()
        private var direct = false
        private var buttons = 0
        private var lastDrag = CGPoint.zero
        private var lastHold = CGPoint.zero
        private var scrollRemainder = CGPoint.zero
        private var lastPan = CGPoint.zero
        private enum TwoFinger { case undecided, scroll, zoom }
        private var twoFinger = TwoFinger.undecided
        private let haptic = UIImpactFeedbackGenerator(style: .light)
        private static let scrollStep: CGFloat = 26

        init(control: ScreenControl) { self.control = control }

        func setDirect(_ on: Bool) {
            guard on != direct else { return }
            direct = on
            show()
        }

        func layout(_ fb: CGSize, _ canvas: CGRect, _ container: CGSize) {
            model.setLayout(fb: fb, canvas: canvas, container: container)
            applyFocus()
            show()
        }

        func setFocus(_ rect: CGRect?) {
            guard rect != appliedFocus, let rect else { return }
            pendingFocus = rect
            applyFocus()
        }

        /// Waits for the first layout (the page reports it once connected), then zooms once.
        private func applyFocus() {
            guard let rect = pendingFocus, model.fb.width > 1 else { return }
            pendingFocus = nil; appliedFocus = rect
            model.focus(on: rect)
            show(); send()
        }

        /// Direct touch: the touch point in framebuffer pixels, moved onto a control close to it.
        private func snapped(atScreen p: CGPoint) -> CGPoint {
            let raw = model.fbPoint(fromScreen: p)
            guard !elements.isEmpty else { return raw }
            let k = elementsSize.width > 0 ? model.fb.width / elementsSize.width : 1
            return model.snap(raw, to: elements.map { CGRect(x: $0.minX * k, y: $0.minY * k, width: $0.width * k, height: $0.height * k) })
        }

        /// Cursor and zoom to the page; the cursor only shows in trackpad mode.
        private func show() {
            control.view(zoom: model.zoom, offset: model.offset, cursor: model.cursorPage, showCursor: !direct)
        }

        private func send() { control.pointer(model.cursor, buttons: buttons) }

        private func click(_ mask: Int) {
            haptic.impactOccurred()
            control.pointer(model.cursor, buttons: mask)
            control.pointer(model.cursor, buttons: 0)
            onClick()
        }

        // MARK: Gestures

        @objc func tap(_ g: UITapGestureRecognizer) {
            // The release of a press-and-hold that already right-clicked is not a tap.
            if holdActive || Date().timeIntervalSince(holdEndedAt) < 0.25 { return }
            if direct { model.place(atFb: snapped(atScreen: g.location(in: g.view))); show() }
            click(1)
        }

        @objc func rightClick(_ g: UITapGestureRecognizer) {
            if direct { model.place(atFb: snapped(atScreen: g.location(in: g.view))); show() }
            click(4)
        }

        /// One finger held still: right click at the cursor (trackpad) or under the finger (direct).
        @objc func rightHold(_ g: UILongPressGestureRecognizer) {
            switch g.state {
            case .began:
                guard buttons == 0 else { return }  // part of a tap-then-hold drag
                holdActive = true
                if direct { model.place(atFb: snapped(atScreen: g.location(in: g.view))); show() }
                click(4)
            case .ended, .cancelled, .failed:
                holdActive = false; holdEndedAt = Date()
            default: break
            }
        }

        @objc func drag(_ g: UIPanGestureRecognizer) {
            let t = g.translation(in: g.view)
            switch g.state {
            case .began: lastDrag = .zero
            case .changed:
                let d = CGSize(width: t.x - lastDrag.x, height: t.y - lastDrag.y)
                lastDrag = t
                if direct {
                    model.pan(by: d)
                } else {
                    let v = g.velocity(in: g.view)
                    model.moveCursor(by: d, speed: hypot(v.x, v.y))
                    model.followCursor()
                    send()
                }
                show()
            default: break
            }
        }

        /// Tap, then touch again and hold: the button goes down and stays down while the finger moves.
        @objc func hold(_ g: UILongPressGestureRecognizer) {
            let p = g.location(in: g.view)
            switch g.state {
            case .began:
                if direct { model.place(atScreen: p) }
                lastHold = p
                buttons = 1
                haptic.impactOccurred()
                show(); send()
            case .changed:
                if direct {
                    model.place(atScreen: p)
                } else {
                    model.moveCursor(by: CGSize(width: p.x - lastHold.x, height: p.y - lastHold.y), speed: 0)
                    model.followCursor()
                }
                lastHold = p
                show(); send()
            case .ended, .cancelled, .failed:
                buttons = 0
                send()
            default: break
            }
        }

        @objc func scroll(_ g: UIPanGestureRecognizer) {
            let t = g.translation(in: g.view)
            switch g.state {
            case .began:
                lastPan = .zero; scrollRemainder = .zero
            case .changed:
                if twoFinger == .undecided, hypot(t.x, t.y) > 14 { twoFinger = .scroll }
                let d = CGPoint(x: t.x - lastPan.x, y: t.y - lastPan.y)
                lastPan = t
                switch twoFinger {
                case .scroll:
                    if direct { model.place(atScreen: g.location(in: g.view)); show() }
                    scrollRemainder.x += d.x; scrollRemainder.y += d.y
                    // Natural scrolling: the page follows the fingers, so dragging up scrolls down.
                    while abs(scrollRemainder.y) >= Self.scrollStep {
                        wheel(up: scrollRemainder.y > 0); scrollRemainder.y -= Self.scrollStep * (scrollRemainder.y > 0 ? 1 : -1)
                    }
                    while abs(scrollRemainder.x) >= Self.scrollStep {
                        wheel(left: scrollRemainder.x > 0); scrollRemainder.x -= Self.scrollStep * (scrollRemainder.x > 0 ? 1 : -1)
                    }
                case .zoom:
                    model.pan(by: CGSize(width: d.x, height: d.y)); show()
                case .undecided: break
                }
            case .ended, .cancelled, .failed: twoFinger = .undecided
            default: break
            }
        }

        @objc func pinch(_ g: UIPinchGestureRecognizer) {
            switch g.state {
            case .changed:
                if twoFinger == .undecided, abs(g.scale - 1) > 0.06 { twoFinger = .zoom }
                guard twoFinger == .zoom else { return }
                model.zoom(by: g.scale, about: direct ? g.location(in: g.view) : model.cursorScreen)
                g.scale = 1
                show()
            case .ended, .cancelled, .failed: twoFinger = .undecided
            default: break
            }
        }

        private func wheel(up: Bool) { control.wheel(model.cursor, bit: up ? 3 : 4) }
        private func wheel(left: Bool) { control.wheel(model.cursor, bit: left ? 5 : 6) }

        // The two-finger gestures run together; each handler decides above which of them the fingers mean.
        func gestureRecognizer(_ a: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith b: UIGestureRecognizer) -> Bool {
            (a is UIPinchGestureRecognizer && b is UIPanGestureRecognizer) || (b is UIPinchGestureRecognizer && a is UIPanGestureRecognizer)
        }
    }
}
