import SwiftUI
import UIKit

/// The ☰ drawer as one UIKit container (ChatGPT / Claude): the sidebar underneath, the tab bar controller on a page
/// that slides right. A drag moves the page with transforms straight from the pan, so no SwiftUI state changes per
/// frame (that re-rendered the whole root on every touch move and made the swipe stutter; the ☰ button was smooth
/// because it only animated). `world.sidebarOpen` stays the source of truth: the pan commits to it on release, and a
/// change from anywhere else (☰, a sidebar row) animates the page.
struct DrawerShell: UIViewControllerRepresentable {
    @Environment(World.self) private var world
    @Environment(\.horizontalSizeClass) private var sizeClass

    func makeUIViewController(context: Context) -> DrawerController {
        DrawerController(world: world, regular: sizeClass == .regular)
    }

    func updateUIViewController(_ controller: DrawerController, context: Context) {}
}

@MainActor
final class DrawerController: UIViewController, UIGestureRecognizerDelegate {
    private let world: World
    private let sidebar: UIHostingController<AnyView>
    private let tabs: JunoTabBarController
    /// Slides; carries the leading-edge shadow (on a path, so it is cheap) and clips the tabs to its corners.
    private let page = UIView()
    /// The washed-out page while the drawer is open (Muse); tapping it closes the drawer.
    private let scrim = UIView()
    /// Darkens the sidebar while it sits back; clears as the page slides away. Full screen and never scaled, so the
    /// canvas the shrunken sidebar uncovers at the screen edges is dimmed with it.
    private let sidebarDim = UIView()
    /// The screen's safe area, handed to the sidebar as padding. The sidebar ignores the system safe area: under the
    /// depth scale its edges move into the status bar, its safe area changed every frame and SwiftUI re-laid it out.
    private var sidebarInsets: EdgeInsets?
    /// Where the page was when the current pan began (an interrupted spring included).
    private var panStart: CGFloat = 0
    private lazy var pan: UIPanGestureRecognizer = {
        let p = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
        p.cancelsTouchesInView = true
        p.delegate = self
        return p
    }()
    private var progress: CGFloat = 0
    private var dragging = false
    private var generation = 0

    /// The slid page's corners follow the phone's own screen corners (Claude), like an app card in the switcher.
    private static let cornerRadius: CGFloat = 55

    /// 75% of the screen, as in the ChatGPT app; the page stays visible on the right.
    private var width: CGFloat { (view.bounds.width * 0.75).rounded() }

    init(world: World, regular: Bool) {
        self.world = world
        sidebar = UIHostingController(rootView: AnyView(Sidebar().environment(world)))
        tabs = JunoTabBarController(world: world, regular: regular)
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        let canvas = UIColor(Theme.canvas)
        view.backgroundColor = canvas

        addChild(sidebar)
        sidebar.view.backgroundColor = canvas
        sidebar.safeAreaRegions = .keyboard
        view.addSubview(sidebar.view)
        sidebar.didMove(toParent: self)
        sidebarDim.backgroundColor = .black
        sidebarDim.isUserInteractionEnabled = false
        view.addSubview(sidebarDim)

        page.backgroundColor = .clear // square fill would hide the rounded corners; the shadow uses a path
        page.layer.shadowColor = UIColor.black.cgColor
        page.layer.shadowOffset = CGSize(width: -6, height: 0)
        page.layer.shadowRadius = 12
        page.layer.shadowOpacity = 0
        view.addSubview(page)

        addChild(tabs)
        tabs.view.layer.cornerCurve = .continuous
        tabs.view.layer.masksToBounds = true
        page.addSubview(tabs.view)
        tabs.didMove(toParent: self)

        scrim.backgroundColor = canvas
        scrim.alpha = 0
        scrim.layer.cornerCurve = .continuous
        scrim.layer.masksToBounds = true
        scrim.isHidden = true
        scrim.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(closeTapped)))
        page.addSubview(scrim)

        view.addGestureRecognizer(pan)
        watch()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let bounds = view.bounds
        // Size while untransformed (like the page); the depth scale is a transform driven by apply().
        let transform = sidebar.view.transform
        sidebar.view.transform = .identity
        sidebar.view.frame = CGRect(x: 0, y: 0, width: width, height: bounds.height)
        sidebar.view.transform = transform
        let safe = view.safeAreaInsets
        let insets = EdgeInsets(top: safe.top, leading: safe.left, bottom: safe.bottom, trailing: 0)
        if insets != sidebarInsets {
            sidebarInsets = insets
            sidebar.rootView = AnyView(Sidebar().environment(world).safeAreaPadding(insets))
        }
        sidebarDim.frame = bounds
        // Frame while untransformed; the slide is a transform on top.
        let pageTransform = page.transform
        page.transform = .identity
        page.frame = bounds
        page.transform = pageTransform
        tabs.view.frame = page.bounds
        scrim.frame = page.bounds
        page.layer.shadowPath = UIBezierPath(roundedRect: page.bounds, cornerRadius: Self.cornerRadius).cgPath
        apply(progress)
    }

    // MARK: Position

    private func apply(_ p: CGFloat) {
        progress = p
        // Sidebar sits back and dark, then comes forward to full size as the page slides away.
        // One whole scale, fixed at the screen's center (not the sidebar's), so the edges drift only slightly.
        let scale = 0.97 + 0.03 * p
        let dx = (view.bounds.midX - width / 2) * (1 - scale)
        sidebar.view.transform = CGAffineTransform(translationX: dx, y: 0).scaledBy(x: scale, y: scale)
        sidebarDim.alpha = 0.35 * (1 - p)
        page.transform = CGAffineTransform(translationX: p * width, y: 0)
        tabs.view.layer.cornerRadius = Self.cornerRadius * min(1, p * 4)
        // The scrim sits on the page outside the clipped tabs: round it too, or its square corners show.
        scrim.layer.cornerRadius = tabs.view.layer.cornerRadius
        page.layer.shadowOpacity = Float(0.10 * p)
        scrim.alpha = 0.55 * p
        scrim.isHidden = p == 0
        let open = p > 0.5
        sidebar.view.isUserInteractionEnabled = open
        sidebar.view.accessibilityElementsHidden = !open
        tabs.view.isUserInteractionEnabled = !open
    }

    /// A finger catches the page mid-spring: stop the spring where it is on screen and continue from there (starting
    /// from the spring's destination made the page and sidebar jump on quick repeated swipes).
    private func catchMotion() {
        let shown = (page.layer.presentation()?.affineTransform().tx ?? page.transform.tx) / max(width, 1)
        for layer in [page.layer, sidebar.view.layer, sidebarDim.layer, scrim.layer] { layer.removeAllAnimations() }
        tabs.view.layer.removeAnimation(forKey: "cornerRadius")
        apply(min(max(shown, 0), 1))
    }

    private func settle(open: Bool, velocity: CGFloat = 0) {
        let target: CGFloat = open ? 1 : 0
        let distance = abs(target - progress) * width
        let springVelocity = distance > 1 ? abs(velocity) / distance : 0
        UIView.animate(withDuration: 0.42, delay: 0, usingSpringWithDamping: 0.92, initialSpringVelocity: springVelocity,
                       options: [.allowUserInteraction, .beginFromCurrentState]) {
            self.apply(target)
        }
    }

    /// `world.sidebarOpen` changed (☰, a sidebar row, the pan's commit): move the page there.
    private func watch() {
        generation += 1
        let mine = generation
        let open = withObservationTracking { world.sidebarOpen } onChange: { [weak self] in
            Task { @MainActor in
                guard let self, self.generation == mine else { return }
                self.watch()
            }
        }
        if !dragging, (progress > 0.5) != open || (progress != 0 && progress != 1) {
            settle(open: open)
        }
    }

    @objc private func closeTapped() { world.sidebarOpen = false }

    // MARK: Pan (same rules as before: horizontal only, right to open, left to close)

    func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        guard g === pan else { return true }
        if presentedViewController != nil || world.sheet != nil { return false }
        let v = pan.velocity(in: view)
        guard abs(v.x) > abs(v.y) * 1.3 else { return false }
        // On the Chat tab a right swipe means "back" in a chat and "pin / mark read" on a list row: there the drawer opens
        // only from the screen's leading edge, and only on the list (no chat open). Screens with `.noDrawerSwipe()` opt
        // out too. Closing always works.
        let fromEdge = pan.location(in: view).x < 44
        let onChatList = world.tab == "chat" && world.currentConversationId == nil && fromEdge
        let canOpen = (world.tab != "chat" || onChatList) && world.drawerSwipeBlockers == 0
        return world.sidebarOpen ? v.x < 0 : (canOpen && v.x > 0)
    }

    // Scroll views (and their horizontal pans) wait for the drawer pan to decide; vertical drags fail it at once.
    func gestureRecognizer(_ g: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
        g === pan && other is UIPanGestureRecognizer && !(other is UIScreenEdgePanGestureRecognizer)
    }

    // A pushed screen's edge-swipe back wins over the drawer.
    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRequireFailureOf other: UIGestureRecognizer) -> Bool {
        g === pan && other is UIScreenEdgePanGestureRecognizer
    }

    @objc private func handlePan(_ g: UIPanGestureRecognizer) {
        let dx = g.translation(in: view).x
        switch g.state {
        case .began, .changed:
            if g.state == .began { catchMotion(); panStart = progress }
            dragging = true
            apply(min(max(panStart + dx / width, 0), 1))
        case .ended:
            dragging = false
            // Conduit's settle rule: a fling decides first (about 300pt/s), else the position (open once past 12%).
            let vx = g.velocity(in: view).x
            let shouldOpen = abs(vx) > 300 ? vx > 0 : progress >= (world.sidebarOpen ? 0.88 : 0.12)
            settle(open: shouldOpen, velocity: vx)
            if world.sidebarOpen != shouldOpen { world.sidebarOpen = shouldOpen }
        default:
            dragging = false
            settle(open: world.sidebarOpen)
        }
    }
}
