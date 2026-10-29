import UIKit

// The chat's interactive keyboard dismissal, ported from Telegram-iOS (Display/WindowContent.swift, WindowPanRecognizer.swift,
// KeyboardManager.swift): a window-level touch recognizer that never takes the touch, a keyboard "upper bound" that follows the
// finger, the system keyboard moved by its host view's bounds, and one spring shared by everything that moves.

/// The system keyboard's host view in the keyboard window (private lookup; nil when there is none, e.g. a hardware keyboard).
enum ChatKeyboardSurface {
    static func window(in scene: UIWindowScene) -> UIWindow? {
        let delegateKey = NSSelectorFromString("keyboardSceneDelegate")
        let windowKey = NSSelectorFromString("keyboardWindow")
        guard scene.responds(to: delegateKey),
              let delegate = scene.perform(delegateKey)?.takeUnretainedValue() as? NSObject,
              delegate.responds(to: windowKey) else { return nil }
        return delegate.perform(windowKey)?.takeUnretainedValue() as? UIWindow
    }

    static func view(in scene: UIWindowScene) -> UIView? {
        guard let window = window(in: scene) else { return nil }
        func host(_ view: UIView) -> UIView? {
            if String(describing: type(of: view)).contains("InputSetHostView") { return view }
            for child in view.subviews { if let found = host(child) { return found } }
            return nil
        }
        return host(window)
    }
}

/// Telegram's WindowPanRecognizer: reports every touch of the window without ever recognizing, so the scroll view and the
/// buttons under the finger keep working. Velocity is the last 0.1 s, divided by 5 like Telegram.
final class ChatKeyboardPanRecognizer: UIGestureRecognizer {
    var began: ((CGPoint) -> Void)?
    var moved: ((CGPoint) -> Void)?
    var ended: ((CGPoint, CGPoint?) -> Void)?
    private var previousPoints: [(CGPoint, Double)] = []

    override func reset() {
        super.reset()
        previousPoints.removeAll()
    }

    private func addPoint(_ point: CGPoint) {
        previousPoints.append((point, CACurrentMediaTime()))
        if previousPoints.count > 6 { previousPoints.removeFirst() }
    }

    private func estimateVerticalVelocity() -> CGFloat {
        let timestamp = CACurrentMediaTime()
        var sum: CGFloat = 0
        var count = 0
        if previousPoints.count > 1 {
            for i in 1 ..< previousPoints.count where previousPoints[i].1 >= timestamp - 0.1 {
                sum += (previousPoints[i].0.y - previousPoints[i - 1].0.y) / CGFloat(previousPoints[i].1 - previousPoints[i - 1].1)
                count += 1
            }
        }
        return count != 0 ? sum / CGFloat(count * 5) : 0
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        if let touch = touches.first {
            let location = touch.location(in: view)
            addPoint(location)
            began?(location)
        }
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesMoved(touches, with: event)
        if let touch = touches.first {
            let location = touch.location(in: view)
            addPoint(location)
            moved?(location)
        }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesEnded(touches, with: event)
        state = .ended
        if let touch = touches.first {
            let location = touch.location(in: view)
            addPoint(location)
            ended?(location, CGPoint(x: 0, y: estimateVerticalVelocity()))
        }
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesCancelled(touches, with: event)
        state = .cancelled
        if let touch = touches.first { ended?(touch.location(in: view), nil) }
    }
}

/// Telegram's ContainedViewLayoutTransition, reduced to what the chat uses.
enum ChatKeyboardTransition: Equatable {
    enum Curve { case spring, easeInOut }
    case immediate
    case animated(duration: Double, curve: Curve)

    static var dismissSpring: ChatKeyboardTransition { .animated(duration: 0.3832, curve: .spring) }
    static let settleSpring = ChatKeyboardTransition.animated(duration: 0.25, curve: .spring)
}

/// One additive animation from `delta` to 0: the layer's model value is already at its destination. Everything that moves
/// with the keyboard goes through here, so it shares one curve and the transaction it is added in.
/// The spring is UIKitUtils.m `make26SpringAnimationImpl`.
@MainActor
func animateAdditiveY(_ layer: CALayer, from delta: CGFloat, keyPath: String = "position.y", transition: ChatKeyboardTransition) {
    guard case let .animated(duration, curve) = transition, abs(delta) > 0.001 else { return }
    let animation: CABasicAnimation
    switch curve {
    case .spring:
        let spring = CASpringAnimation(keyPath: keyPath)
        spring.mass = 1
        spring.stiffness = 555.027
        spring.damping = 47.118
        spring.allowsOverdamping = false
        spring.timingFunction = CAMediaTimingFunction(name: .linear)
        spring.preferredFrameRateRange = CAFrameRateRange(minimum: 80, maximum: 120, preferred: 120)
        animation = spring
    case .easeInOut:
        animation = CABasicAnimation(keyPath: keyPath)
        animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    }
    animation.fromValue = delta
    animation.toValue = 0
    animation.duration = duration
    animation.isAdditive = true
    animation.fillMode = .forwards
    layer.add(animation, forKey: nil)
}

/// Owned by the chat page. Knows the keyboard's height, where the finger holds it (`upperBound`, in the chat view's space)
/// and moves the system keyboard; the page lays out the composer and the list from `effectiveHeight` in `apply`.
@MainActor
final class ChatKeyboardController: NSObject, UIGestureRecognizerDelegate {
    weak var view: UIView?
    weak var composer: UIView?
    /// The "+" menu is closed and nothing is presented over the chat.
    var isIdle: () -> Bool = { true }
    /// How far the list is scrolled from its newest message.
    var distanceFromNewest: () -> CGFloat = { 0 }
    /// Lay the page out for the current `effectiveHeight` inside the transition (called within one CATransaction).
    var apply: (ChatKeyboardTransition, _ scrollToNewest: Bool) -> Void = { _, _ in }
    /// The keyboard has no surface to move: the list falls back to `.onDrag`.
    var surfaceMissing: (Bool) -> Void = { _ in }

    private(set) var keyboardHeight: CGFloat = 0
    private(set) var upperBound: CGFloat?
    private var beginLocation: CGPoint?
    private var accessoryHeight: CGFloat = 0
    private(set) var dismissedByCurrentGesture = false
    private(set) var beganAtNewest = false
    private weak var surface: UIView?
    private var recognizer: ChatKeyboardPanRecognizer?

    override init() {
        super.init()
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(keyboardWillChangeFrame(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        center.addObserver(self, selector: #selector(keyboardDidShow), name: UIResponder.keyboardDidShowNotification, object: nil)
    }

    isolated deinit { NotificationCenter.default.removeObserver(self) }

    // MARK: Derived (pure; the unit tests exercise these)

    static func interactiveOffset(upperBound: CGFloat?, viewHeight: CGFloat, keyboardHeight: CGFloat) -> CGFloat {
        upperBound.map { max(0, $0 - (viewHeight - keyboardHeight)) } ?? 0
    }

    /// Telegram `panGestureEnded`: dismissed by position (dragged to the bottom) or by a flick, and only when the finger
    /// ended inside the keyboard's zone.
    static func canDismiss(upperBound: CGFloat?, viewHeight: CGFloat, accessoryHeight: CGFloat, velocity: CGFloat?,
                           fingerY: CGFloat, keyboardHeight: CGFloat) -> Bool {
        var can = false
        if let upperBound, upperBound >= viewHeight - accessoryHeight {
            can = true
        } else if let velocity, velocity > 100 {
            can = true
        }
        return can && fingerY + accessoryHeight > viewHeight - keyboardHeight
    }

    private var viewHeight: CGFloat { view?.bounds.height ?? 0 }
    var interactiveOffset: CGFloat {
        Self.interactiveOffset(upperBound: upperBound, viewHeight: viewHeight, keyboardHeight: keyboardHeight)
    }
    var effectiveHeight: CGFloat { max(0, keyboardHeight - interactiveOffset) }

    // MARK: Recognizer

    func install(in window: UIWindow?) {
        guard recognizer == nil, let window, UIDevice.current.userInterfaceIdiom == .phone else { return }
        let recognizer = ChatKeyboardPanRecognizer(target: nil, action: nil)
        recognizer.cancelsTouchesInView = false
        recognizer.delaysTouchesBegan = false
        recognizer.delaysTouchesEnded = false
        recognizer.delegate = self
        recognizer.began = { [weak self] in self?.began($0) }
        recognizer.moved = { [weak self] in self?.moved($0) }
        recognizer.ended = { [weak self] in self?.ended($0, velocity: $1?.y) }
        window.addGestureRecognizer(recognizer)
        self.recognizer = recognizer
    }

    func uninstall() {
        recognizer?.view?.removeGestureRecognizer(recognizer!)
        recognizer = nil
        cancel()
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard let view = gestureRecognizer.view else { return true }
        return touch.location(in: view).y <= view.bounds.height - 44
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRequireFailureOf other: UIGestureRecognizer) -> Bool { false }

    // MARK: Gesture (Telegram panGestureBegan / Moved / Ended)

    private func local(_ windowPoint: CGPoint) -> CGPoint {
        guard let view, let window = view.window else { return windowPoint }
        return view.convert(windowPoint, from: window)
    }

    private func began(_ windowPoint: CGPoint) {
        dismissedByCurrentGesture = false
        let location = local(windowPoint)
        guard upperBound == nil, let view, let composer, keyboardHeight > 0, isIdle(),
              location.y < view.bounds.height - keyboardHeight - composer.bounds.height,
              let scene = view.window?.windowScene, let surface = ChatKeyboardSurface.view(in: scene),
              Self.firstResponder(in: composer) != nil else { return }
        self.surface = surface
        beginLocation = location
        accessoryHeight = composer.bounds.height
        beganAtNewest = distanceFromNewest() <= 10
    }

    private func moved(_ windowPoint: CGPoint) {
        guard let beginLocation else { return }
        let location = local(windowPoint)
        let dy = beginLocation.y - location.y
        if dy * dy >= 9 || upperBound != nil {
            upperBound = location.y + accessoryHeight
            run(.immediate)
        }
    }

    private func ended(_ windowPoint: CGPoint, velocity: CGFloat?) {
        guard beginLocation != nil else { return }
        beginLocation = nil
        let location = local(windowPoint)
        if Self.canDismiss(upperBound: upperBound, viewHeight: viewHeight, accessoryHeight: accessoryHeight,
                           velocity: velocity, fingerY: location.y, keyboardHeight: keyboardHeight) {
            // The scroll view released by this same finger reads this and declines to fling.
            dismissedByCurrentGesture = true
            upperBound = viewHeight
            run(.dismissSpring, scrollToNewest: beganAtNewest) { [weak self] in self?.finishDismiss() }
        } else if upperBound != nil {
            upperBound = nil
            run(.settleSpring)
        }
    }

    /// Navigation away, a back swipe: drop the gesture; a keyboard held down by the finger springs back.
    func cancel() {
        beginLocation = nil
        if upperBound != nil {
            upperBound = nil
            run(.settleSpring)
        }
    }

    /// The keyboard is already off screen: take it away without its own animation (Telegram dismissEditingWithoutAnimation),
    /// and only then give the surface its place back.
    private func finishDismiss() {
        UIView.performWithoutAnimation { view?.endEditing(true) }
        if let scene = view?.window?.windowScene, let window = ChatKeyboardSurface.window(in: scene) {
            window.subviews.forEach(Self.stripAnimations)
        }
        if composer.flatMap({ Self.firstResponder(in: $0) }) == nil { keyboardHeight = 0 }
        upperBound = nil
        run(.immediate)
    }

    private static func stripAnimations(_ view: UIView) {
        view.layer.removeAllAnimations()
        view.subviews.forEach(stripAnimations)
    }

    static func firstResponder(in view: UIView) -> UIView? {
        if view.isFirstResponder { return view }
        for child in view.subviews { if let found = firstResponder(in: child) { return found } }
        return nil
    }

    // MARK: Moving things

    private func run(_ transition: ChatKeyboardTransition, scrollToNewest: Bool = false, completion: (() -> Void)? = nil) {
        CATransaction.begin()
        if let completion { CATransaction.setCompletionBlock(completion) }
        apply(transition, scrollToNewest)
        moveSurface(transition)
        CATransaction.commit()
    }

    /// Telegram KeyboardManager.updateInteractiveInputOffset: the keyboard's host view is moved by its bounds origin.
    private func moveSurface(_ transition: ChatKeyboardTransition) {
        let offset = interactiveOffset
        if surface == nil, offset > 0, let scene = view?.window?.windowScene { surface = ChatKeyboardSurface.view(in: scene) }
        guard let surface else { return }
        let previous = surface.layer.bounds.origin.y
        guard previous != -offset else { return }
        surface.layer.bounds.origin.y = -offset
        animateAdditiveY(surface.layer, from: previous + offset, keyPath: "bounds.origin.y", transition: transition)
    }

    // MARK: Keyboard notifications

    @objc private func keyboardWillChangeFrame(_ note: Notification) {
        guard let view, let info = note.userInfo,
              let end = (info[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let height: CGFloat
        if let window = view.window {
            let frame = (note.object as? UIScreen ?? window.screen).coordinateSpace.convert(end, to: view)
            let floating = frame.width < view.bounds.width - 0.5 || frame.maxY < view.bounds.maxY - 0.5
            height = floating ? 0 : max(0, view.bounds.maxY - frame.minY)
        } else if let screen = note.object as? UIScreen {
            let floating = end.width < screen.bounds.width - 0.5 || end.maxY < screen.bounds.maxY - 0.5
            height = floating ? 0 : max(0, screen.bounds.maxY - end.minY)
        } else { return }
        let duration = info[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
        let curve = info[UIResponder.keyboardAnimationCurveUserInfoKey] as? Int ?? 0
        var transition: ChatKeyboardTransition = duration <= 0 ? .immediate
            : .animated(duration: duration, curve: curve == 7 ? .spring : .easeInOut)
        // The suggestion bar appearing or going away: the keyboard barely changes height, nothing should animate.
        if keyboardHeight > 0, height > 0, abs(height - keyboardHeight) <= 44.1 { transition = .immediate }
        // A finger-held keyboard that now goes away: its place is already taken.
        if upperBound != nil, height == 0 { transition = .immediate }
        keyboardHeight = height
        run(transition)
    }

    @objc private func keyboardDidShow() {
        guard let scene = view?.window?.windowScene, UIDevice.current.userInterfaceIdiom == .phone else { return }
        surfaceMissing(ChatKeyboardSurface.view(in: scene) == nil)
    }
}
