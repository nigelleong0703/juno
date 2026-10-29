import SwiftUI
import UIKit

// UIKit-backed recognizers for the chat bubbles. SwiftUI's onLongPressGesture / DragGesture stacked on every
// bubble (plus the drawer's) made the scroll view wait on them: scrolling lagged and taps needed two tries.
// UIKit recognizers coexist with the scroll view's own pan: the pan here begins only on a rightward, mostly
// horizontal drag (so it never contests a vertical scroll), the long press fails once the finger moves.

/// Rightward horizontal pan: reports the translation (clamped at 0) while it runs and the end.
struct HorizontalPan: UIGestureRecognizerRepresentable {
    var onChange: (CGFloat) -> Void
    var onEnd: () -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Delegate { Delegate() }
    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let p = UIPanGestureRecognizer()
        p.delegate = context.coordinator
        return p
    }
    func handleUIGestureRecognizerAction(_ g: UIPanGestureRecognizer, context: Context) {
        switch g.state {
        case .changed: onChange(max(g.translation(in: g.view).x, 0))
        case .ended, .cancelled, .failed: onEnd()
        default: break
        }
    }

    final class Delegate: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            guard let p = g as? UIPanGestureRecognizer else { return false }
            let v = p.velocity(in: p.view)
            return v.x > 0 && abs(v.x) > abs(v.y) * 1.3
        }
    }
}

/// Press and hold: fires once at `minimumPressDuration`; any real movement (a scroll starting) cancels it.
struct HoldPress: UIGestureRecognizerRepresentable {
    var onHold: () -> Void

    func makeUIGestureRecognizer(context: Context) -> UILongPressGestureRecognizer {
        let g = UILongPressGestureRecognizer()
        g.minimumPressDuration = 0.4
        g.allowableMovement = 8
        return g
    }
    func handleUIGestureRecognizerAction(_ g: UILongPressGestureRecognizer, context: Context) {
        if g.state == .began { onHold() }
    }
}
