import SwiftUI
import UIKit

/// The native iOS 26 tab bar (Liquid Glass): Today, Team, Discover and Library host their SwiftUI roots. Feed, Ideas and Goals
/// are pushed from Today and Team, not tabs. Chat is a UIKit
/// navigation controller (large title, search, a chat pushed with the bar sliding away) as in WhatsApp.
struct JunoTabs: UIViewControllerRepresentable {
    @Environment(World.self) private var world
    @Environment(\.horizontalSizeClass) private var sizeClass

    func makeUIViewController(context: Context) -> JunoTabBarController {
        JunoTabBarController(world: world, regular: sizeClass == .regular)
    }

    func updateUIViewController(_ controller: JunoTabBarController, context: Context) {}
}

@MainActor
final class JunoTabBarController: UITabBarController, UITabBarControllerDelegate {
    /// Same order as `viewControllers`.
    /// Five tabs, owner-approved 2026-10-26: Today · Chat · Team · Discover · Library.
    private static let tabs: [(key: String, title: String, symbol: String)] = [
        ("today", "Today", "sun.max"), ("chat", "Chat", "bubble.left"), ("team", "Team", "person.2"),
        ("discover", "Discover", "square.grid.2x2"), ("library", "Library", "folder"),
    ]
    private let world: World
    private var generation = 0

    init(world: World, regular: Bool) {
        self.world = world
        super.init(nibName: nil, bundle: nil)
        delegate = self
        view.tintColor = UIColor(Theme.primary) // the web is neutral: no blue anywhere
        tabBar.tintColor = UIColor(Theme.fg)

        let chat: UIViewController = regular ? host(ChatScreen()) : ChatsNavigationController(world: world)
        // Every tab is a UIKit navigation stack (Chats has its own, driven by the open chat): a page pushed from any
        // tab slides over it with the tab bar, the same everywhere.
        let controllers: [UIViewController] = [
            page(TodayTab().toolbar { SidebarButton() }),
            chat,
            page(TeamTab().toolbar { SidebarButton() }),
            page(DiscoverTab().toolbar { SidebarButton() }),
            page(GlobalPageView(page: .library).toolbar { SidebarButton() }),
        ]
        for (vc, tab) in zip(controllers, Self.tabs) {
            // Icon-only, outline in both states (the bar fills a symbol that has no selected image of its own).
            let image = UIImage(systemName: tab.symbol)?.withRenderingMode(.alwaysTemplate)
            vc.tabBarItem = UITabBarItem(title: "", image: image, selectedImage: image)
            vc.tabBarItem.accessibilityLabel = tab.title
        }
        setViewControllers(controllers, animated: false)
        refresh()
        watchAgentPage()
        watchPostPage()
        watchPendingRoute()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private func page<V: View>(_ root: V) -> UIViewController {
        let nav = PageNavigationController(world: world)
        nav.setRoot(root)
        return nav
    }

    private func host<V: View>(_ root: V) -> UIViewController {
        let vc = UIHostingController(rootView: root.environment(world))
        vc.view.backgroundColor = UIColor(Theme.canvas)
        return vc
    }

    /// World → bar: the selected tab and the badges (Chat: what needs you; Feed: today's unseen posts), again after every change.
    private func refresh() {
        generation += 1
        let mine = generation
        let (tab, pending, unseen) = withObservationTracking {
            (world.tab, world.needsYou.count, world.unseenFeedToday)
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self, self.generation == mine else { return }
                self.refresh()
            }
        }
        if let index = Self.tabs.firstIndex(where: { $0.key == tab }), selectedIndex != index { selectedIndex = index; restoreBars() }
        // Needs you rides on Today (the first tab); the unseen Feed count is read in Today's Updates block.
        if tab == "today", unseen > 0 { world.markFeedSeen() }
        viewControllers?[0].tabBarItem.badgeValue = pending > 0 ? "\(pending)" : nil
    }

    /// `world.agentPage` → the agent card, a full-screen cover with UIKit's native zoom out of the tapped avatar
    /// (`AgentZoomSources`). Without a source on screen it is the plain cover animation.
    private var agentGeneration = 0
    private func watchAgentPage() {
        agentGeneration += 1
        let mine = agentGeneration
        let target = withObservationTracking {
            world.agentPage
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self, self.agentGeneration == mine else { return }
                self.watchAgentPage()
            }
        }
        var top: UIViewController = self
        while let next = top.presentedViewController { top = next }
        if let target {
            if let closing = top as? CoverHostingController, !closing.isPost {
                // Tapped again while the last card is still zooming back: open once that transition ends.
                guard closing.isBeingDismissed, let coordinator = closing.transitionCoordinator else { return }
                coordinator.animate(alongsideTransition: nil) { [weak self] _ in self?.watchAgentPage() }
                return
            }
            let card = CoverHostingController(AgentCardView(agentId: target.agentId, tab: target.tab), world: world)
            card.onDismiss = { [weak self] in if self?.world.agentPage == target { self?.world.agentPage = nil } }
            card.onDismissCancelled = { [weak self] in if self?.world.agentPage == nil { self?.world.agentPage = target } }
            card.modalPresentationStyle = .fullScreen
            let source = target.sourceId
            if AgentZoomSources.view(for: source) != nil {
                card.preferredTransition = .zoom { _ in AgentZoomSources.view(for: source) }
            }
            top.present(card, animated: true)
        } else if let card = top as? CoverHostingController, !card.isPost, !card.isBeingDismissed {
            card.dismiss(animated: true)
        }
    }

    /// `world.pendingRoute` → pushed onto the selected tab's stack, like a row tapped inside that tab.
    private var routeGeneration = 0
    private func watchPendingRoute() {
        routeGeneration += 1
        let mine = routeGeneration
        let route = withObservationTracking {
            world.pendingRoute
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self, self.routeGeneration == mine else { return }
                self.watchPendingRoute()
            }
        }
        guard let route else { return }
        world.pendingRoute = nil
        switch selectedViewController {
        case let nav as PageNavigationController: nav.push(route)
        case let nav as ChatsNavigationController: nav.push(route)
        default: break
        }
    }

    /// `world.postPage` → a Feed post, covered the same way as the agent card: over the tab bar, which is never touched.
    private var postGeneration = 0
    private func watchPostPage() {
        postGeneration += 1
        let mine = postGeneration
        let target = withObservationTracking {
            world.postPage
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self, self.postGeneration == mine else { return }
                self.watchPostPage()
            }
        }
        var top: UIViewController = self
        while let next = top.presentedViewController { top = next }
        if let id = target {
            if let closing = top as? CoverHostingController, closing.isPost {
                guard closing.isBeingDismissed, let coordinator = closing.transitionCoordinator else { return }
                coordinator.animate(alongsideTransition: nil) { [weak self] _ in self?.watchPostPage() }
                return
            }
            let post = CoverHostingController(FeedPostDetail(postId: id), world: world, isPost: true)
            post.onDismiss = { [weak self] in if self?.world.postPage == id { self?.world.postPage = nil } }
            post.onDismissCancelled = { [weak self] in if self?.world.postPage == nil { self?.world.postPage = id } }
            post.modalPresentationStyle = .fullScreen
            if AgentZoomSources.view(for: "feed-\(id)") != nil {
                post.preferredTransition = .zoom { _ in AgentZoomSources.view(for: "feed-\(id)") }
            }
            top.present(post, animated: true)
        } else if let post = top as? CoverHostingController, post.isPost, !post.isBeingDismissed {
            post.dismiss(animated: true)
        }
    }

    /// A tab switch while a page was pushed: the bar is the new tab's again, no snapshot of the old one stays behind.
    private func restoreBars() {
        for case let nav as UINavigationController in viewControllers ?? [] { restoreTabBar(of: nav) }
    }

    func tabBarController(_ tabBarController: UITabBarController, didSelect viewController: UIViewController) {
        guard selectedIndex < Self.tabs.count else { return }
        restoreBars()
        let key = Self.tabs[selectedIndex].key
        if world.tab != key { world.tab = key }
    }
}

/// The tab bar belongs to the tab's root page and moves with it (WhatsApp, Telegram, Messages): when a page is pushed
/// from the root, a snapshot of the bar is placed in the root's view and the real bar is hidden at once, so the
/// push slides the root away with its bar and the page covers both; an interactive swipe back drags them 1:1 and a
/// cancelled one leaves them covered. When the pop to the root finishes (and was not cancelled) the real bar returns and the
/// snapshot goes in the same runloop. UIKit alone cannot do this: its bar is a global overlay that it fades or slides
/// by itself on iOS 26 (the Liquid Glass platter ignores alpha).
private let tabBarSnapshotTag = 0x7AB5

/// Keeps the real bar hidden while its snapshot is in a root page: UIKit shows it again by itself when a pop starts.
@MainActor
private final class TabBarHider {
    private var observations: [NSKeyValueObservation] = []
    func hold(_ bar: UITabBar) {
        bar.isHidden = true
        observations = [bar.observe(\.isHidden, options: [.new]) { bar, _ in
            if !bar.isHidden { MainActor.assumeIsolated { bar.isHidden = true } }
        }]
    }
    func release(_ bar: UITabBar) {
        observations = []
        bar.isHidden = false
    }
}
@MainActor private let tabBarHider = TabBarHider()

@MainActor
private func carryTabBar(of navigation: UINavigationController, showing page: UIViewController) {
    guard let root = navigation.viewControllers.first, let bar = navigation.tabBarController?.tabBar else { return }
    let coordinator = navigation.transitionCoordinator
    if page !== root {
        // Pushed from the root: its bar goes into the root's view. (Not animated: UIKit hides the bar at once, nothing to carry.)
        guard coordinator?.viewController(forKey: .from) === root, root.isViewLoaded, !bar.isHidden,
              root.view.viewWithTag(tabBarSnapshotTag) == nil,
              let window = bar.window else { return }
        // A picture of the bar's strip of the screen: `snapshotView` loses the Liquid Glass platter's icons.
        let strip = CGRect(x: 0, y: bar.frame.minY, width: window.bounds.width, height: window.bounds.height - bar.frame.minY)
        let image = UIGraphicsImageRenderer(bounds: strip).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
        }
        let snapshot = UIImageView(image: image)
        snapshot.tag = tabBarSnapshotTag
        snapshot.frame = window.convert(strip, to: root.view)
        snapshot.autoresizingMask = [.flexibleTopMargin, .flexibleWidth]
        root.view.addSubview(snapshot)
        tabBarHider.hold(bar)
    } else if let coordinator {
        coordinator.animate(alongsideTransition: nil) { context in
            if !context.isCancelled { MainActor.assumeIsolated { restoreTabBar(of: navigation) } }
        }
    } else {
        restoreTabBar(of: navigation)
    }
}

@MainActor
private func restoreTabBar(of navigation: UINavigationController) {
    guard let bar = navigation.tabBarController?.tabBar else { return }
    navigation.viewControllers.first?.view.viewWithTag(tabBarSnapshotTag)?.removeFromSuperview()
    if navigation.viewControllers.count == 1 { tabBarHider.release(bar) }
}

/// The Chats tab: the list, and a chat pushed over it with the tab bar sliding away (`hidesBottomBarWhenPushed`).
/// `world.currentConversationId` is the source of truth: setting it pushes, popping (button, edge swipe) clears it.
@MainActor
final class ChatsNavigationController: UINavigationController, UINavigationControllerDelegate {
    private let world: World
    private var generation = 0

    init(world: World) {
        self.world = world
        super.init(rootViewController: ChatListViewController(world: world))
        navigationBar.prefersLargeTitles = false
        delegate = self
        sync()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private func sync() {
        generation += 1
        let mine = generation
        let id = withObservationTracking {
            world.currentConversationId
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self, self.generation == mine else { return }
                self.sync()
            }
        }
        if let coordinator = transitionCoordinator {
            // Mid-transition (an interactive swipe, a push): UIKit refuses another change until it ends.
            coordinator.animate(alongsideTransition: nil) { [weak self] _ in self?.apply(id) }
        } else {
            apply(id)
        }
    }

    private func apply(_ id: String?) {
        let shown = viewControllers.count > 1 ? (viewControllers[1] as? ChatHostingController)?.conversationId : nil
        let visible = view.window != nil
        if let id {
            guard shown != id, let root = viewControllers.first else { return }
            // A different chat replaces the open one; the first one slides in.
            setViewControllers([root, ChatHostingController(conversationId: id, world: world) { [weak self] in self?.push($0) }],
                               animated: visible && shown == nil && viewControllers.count == 1)
        } else if viewControllers.count > 1 {
            popToRootViewController(animated: visible)
        }
    }

    /// A route opened from a row inside a chat: the same page `junoDestinations` would show, pushed on this stack.
    func push(_ route: Route) {
        let push: (Route) -> Void = { [weak self] in self?.push($0) }
        let vc = UIHostingController(rootView: RouteDestination(route: route).environment(world).environment(\.openRoute, push))
        vc.view.backgroundColor = UIColor(Theme.canvas)
        vc.hidesBottomBarWhenPushed = true
        pushViewController(vc, animated: true)
    }

    func navigationController(_ navigationController: UINavigationController, willShow viewController: UIViewController, animated: Bool) {
        carryTabBar(of: navigationController, showing: viewController)
    }

    /// After the transition, so also after an interactive swipe back: the list is showing, no chat is open.
    func navigationController(_ navigationController: UINavigationController, didShow viewController: UIViewController, animated: Bool) {
        if viewController === viewControllers.first, world.currentConversationId != nil { world.currentConversationId = nil }
    }
}

/// A tab whose pages push on a UIKit stack (Feed, Ideas, Goals, Library): a chat opened from it is the same `ChatHostingController` the
/// Chats tab pushes, so the tab bar slides away with the page there too; other routes are hosted `RouteDestination`s.
@MainActor
final class PageNavigationController: UINavigationController, UINavigationControllerDelegate {
    private let world: World

    init(world: World) {
        self.world = world
        super.init(nibName: nil, bundle: nil)
        delegate = self
        // One transparent bar for every page: no fill, no hairline, whether the content is at the top or scrolled.
        let bar = UINavigationBarAppearance()
        bar.configureWithTransparentBackground()
        bar.shadowColor = .clear
        navigationBar.standardAppearance = bar
        navigationBar.scrollEdgeAppearance = bar
        navigationBar.compactAppearance = bar
        navigationBar.compactScrollEdgeAppearance = bar
    }

    func navigationController(_ navigationController: UINavigationController, willShow viewController: UIViewController, animated: Bool) {
        carryTabBar(of: navigationController, showing: viewController)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func setRoot<V: View>(_ root: V) {
        let vc = UIHostingController(rootView: AnyView(root.environment(world).environment(\.openRoute) { [weak self] in self?.push($0) }))
        vc.view.backgroundColor = UIColor(Theme.canvas)
        setViewControllers([vc], animated: false)
    }

    func push(_ route: Route) {
        let push: (Route) -> Void = { [weak self] in self?.push($0) }
        let vc: UIViewController
        if case .chat(let id) = route {
            world.prepareChat(id)
            vc = ChatHostingController(conversationId: id, world: world, push: push)
        } else {
            let pop: () -> Void = { [weak self] in self?.popViewController(animated: true) }
            let page = UIHostingController(rootView: RouteDestination(route: route).environment(world).environment(\.openRoute, push).environment(\.popPage, pop))
            page.view.backgroundColor = UIColor(Theme.canvas)
            page.hidesBottomBarWhenPushed = true
            vc = page
        }
        pushViewController(vc, animated: true)
    }
}

/// A chat page. The composer (and the jump button) are hosted here in their own hosting controllers and
/// pinned to the bottom by a constant that `ChatKeyboardController` drives: the keyboard's height, less what the finger
/// holds it down by (Telegram's mechanism, see `ChatKeyboard.swift`). Whatever moves with it moves in one transaction
/// with one additive animation, the list included.
private final class ChatHostingController: UIHostingController<AnyView> {
    let conversationId: String
    private let store = ChatStore()
    private let composerHost: UIHostingController<AnyView>
    private let jumpHost: UIHostingController<AnyView>
    private let keyboard = ChatKeyboardController()
    private var composerBottom: NSLayoutConstraint?
    /// The composer's height at the screen's width. `.intrinsicContentSize` cannot give it: UIKit asks for it with no
    /// width, where the text fits on one line, so the field never grew. The hosted view reports its own height instead.
    private var composerHeight: NSLayoutConstraint?
    private var applying = false
    private var composerEdge: ChatComposerEdge?

    init(conversationId: String, world: World, push: @escaping (Route) -> Void) {
        self.conversationId = conversationId
        let store = store
        var reportHeight: (CGFloat) -> Void = { _ in }
        composerHost = UIHostingController(rootView: AnyView(ChatComposerBar(store: store, conversationId: conversationId)
            .environment(world).environment(\.pushRoute, push)
            // Its height for the width it has, whatever height it was given: the reading that drives the constraint.
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { reportHeight($0) }))
        jumpHost = UIHostingController(rootView: AnyView(ChatJumpButton(store: store)))
        super.init(rootView: AnyView(ConversationView(conversationId: conversationId, store: store).id(conversationId)
            .environment(world).environment(\.pushRoute, push).environment(\.composerHosted, true)))
        reportHeight = { [weak self] height in self?.setComposerHeight(height) }
        hidesBottomBarWhenPushed = true
        navigationItem.largeTitleDisplayMode = .never
        view.backgroundColor = UIColor(Theme.canvas)
        store.composerSide = Self.restSide
        store.keyboardDismissMode = .none
        store.shouldStopScrolling = { [weak keyboard] in keyboard?.dismissedByCurrentGesture == true }
        keyboard.isIdle = { [weak self] in self?.presentedViewController == nil }
        keyboard.distanceFromNewest = { [weak store] in store?.controller?.distanceFromNewest ?? 0 }
        keyboard.apply = { [weak self] transition, scrollToNewest in self?.apply(transition, scrollToNewest: scrollToNewest) }
        keyboard.surfaceMissing = { [weak store] missing in store?.keyboardDismissMode = missing ? .onDrag : .none }
        #if DEBUG
        store.motionChrome = { [weak self] in
            guard let self, let composer = chatMotionFrame(composerHost.view) else { return nil }
            return ChatMotionChrome(composer: composer, keyboard: keyboardFrame())
        }
        #endif
    }

    @MainActor required dynamic init?(coder aDecoder: NSCoder) { fatalError("init(coder:) is not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        keyboard.view = view
        keyboard.composer = composerHost.view
        for host in [composerHost, jumpHost] {
            host.sizingOptions = host === composerHost ? [] : .intrinsicContentSize
            host.view.backgroundColor = .clear
            host.view.translatesAutoresizingMaskIntoConstraints = false
            // The composer's constant already stops it above the home indicator.
            host.safeAreaRegions = []
            addChild(host)
            view.addSubview(host.view)
            host.didMove(toParent: self)
        }
        composerEdge = ChatComposerEdge(view: composerHost.view)
        let bottom = composerHost.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        composerBottom = bottom
        let height = composerHost.view.heightAnchor.constraint(equalToConstant: composerHeightValue)
        composerHeight = height
        NSLayoutConstraint.activate([
            composerHost.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            composerHost.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bottom, height,
            jumpHost.view.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            jumpHost.view.bottomAnchor.constraint(equalTo: composerHost.view.topAnchor, constant: -8),
        ])
        updateBottom()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        keyboard.install(in: view.window)
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        keyboard.uninstall()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        composerEdge?.attach(in: view.window)
        guard !applying else { return }
        updateBottom()
        syncList(.immediate, scrollToNewest: false)
    }

    private var composerHeightValue: CGFloat = 56

    /// The composer grew or shrank (a line typed, the notice appeared): the constraint follows, the list's inset with it.
    private func setComposerHeight(_ height: CGFloat) {
        guard height > 0, abs(height - composerHeightValue) > 0.5 else { return }
        composerHeightValue = height
        composerHeight?.constant = height
        view.setNeedsLayout()
    }

    private func updateBottom() {
        // Messages' gaps: `keyboardGap` above the keyboard; at rest the home indicator's inset less 6pt (12pt minimum, for
        // devices with no inset). The gap eases between them as a finger lowers the keyboard.
        let lifted = keyboard.effectiveHeight
        let rest = max(view.safeAreaInsets.bottom - 6, 12)
        let constant = -(lifted + rest + (Self.keyboardGap - rest) * keyboardProgress)
        if composerBottom?.constant != constant { composerBottom?.constant = constant }
    }

    /// The composer's gap above the keyboard's top edge.
    private static let keyboardGap: CGFloat = 8
    /// The composer's side inset: 28pt with the keyboard down; with it up, the inset of iOS 26's floating keyboard card,
    /// so the pill lines up with the keys' edges.
    private static let restSide: CGFloat = 28
    private static let keyboardSide: CGFloat = 8

    /// 0 with the keyboard down, 1 fully up: the same value that places the composer, finger-held keyboard included.
    private var keyboardProgress: CGFloat {
        keyboard.keyboardHeight > 0 ? min(1, keyboard.effectiveHeight / keyboard.keyboardHeight) : 0
    }

    /// The side inset follows the same progress as the composer's place, with the spring's numbers when it animates.
    private func updateSide(_ transition: ChatKeyboardTransition) {
        let side = Self.restSide + (Self.keyboardSide - Self.restSide) * keyboardProgress
        guard abs((store.composerSide ?? Self.restSide) - side) > 0.01 else { return }
        if case .animated = transition {
            withAnimation(.interpolatingSpring(mass: 1, stiffness: 555.027, damping: 47.118)) { store.composerSide = side }
        } else {
            var t = Transaction(); t.disablesAnimations = true
            withTransaction(t) { store.composerSide = side }
        }
    }

    /// Telegram `updateLayout`: the composer and jump button take their new place and ease from the old one, the list
    /// follows with the same transition, and the keyboard (moved by the controller) with it.
    private func apply(_ transition: ChatKeyboardTransition, scrollToNewest: Bool) {
        let hosts = [composerHost.view!, jumpHost.view!]
        let before = hosts.map { $0.frame.minY }
        applying = true
        updateBottom()
        updateSide(transition)
        UIView.performWithoutAnimation { view.layoutIfNeeded() }
        applying = false
        for (host, old) in zip(hosts, before) {
            animateAdditiveY(host.layer, from: old - host.frame.minY, transition: transition)
        }
        syncList(transition, scrollToNewest: scrollToNewest)
    }

    private func syncList(_ transition: ChatKeyboardTransition, scrollToNewest: Bool) {
        store.setComposerInset(view.bounds.maxY - composerHost.view.frame.minY, transition: transition, scrollToNewest: scrollToNewest)
    }

    #if DEBUG
    /// Where the keyboard's contents are on screen (its host view's bounds moves them, not its own frame).
    private func keyboardFrame() -> CGRect? {
        guard let scene = view.window?.windowScene, let surface = ChatKeyboardSurface.view(in: scene) else { return nil }
        let frames = surface.subviews.compactMap { chatMotionFrame($0) }
        return frames.dropFirst().reduce(frames.first) { $0?.union($1) }
    }
    #endif
}

/// A full-screen cover over the tab bar that zooms out of its source view: the agent card and a Feed post.
private final class CoverHostingController: UIHostingController<AnyView> {
    var onDismiss: () -> Void = {}
    var onDismissCancelled: () -> Void = {}
    let isPost: Bool

    init(_ root: some View, world: World, isPost: Bool = false) {
        self.isPost = isPost
        super.init(rootView: AnyView(root.environment(world)))
        view.backgroundColor = UIColor(Theme.canvas)
    }

    @MainActor required dynamic init?(coder aDecoder: NSCoder) { fatalError("init(coder:) is not used") }

    /// Closing (button or swipe) spends the target as the dismissal starts, not after the zoom-back ends: a tap on the
    /// same avatar during that animation is then a new open instead of a no-op. A cancelled swipe puts it back.
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        guard isBeingDismissed else { return }
        onDismiss()
        transitionCoordinator?.animate(alongsideTransition: nil) { [weak self] context in
            if context.isCancelled { self?.onDismissCancelled() }
        }
    }
}
