import SwiftUI
import UIKit

/// The agent card: a page on its tab's stack. Its Share / "…" are the page's own bar items (the bar belongs to the
/// navigation controller, so it stays put while the page zooms), the left is the system back button. Routes opened from
/// the page push onto the same stack (`openRoute`).
///
/// Opening and closing are UIKit's native zoom of the page, from and back to a stand-in view of the avatar it was
/// opened from (`proxy`: the real avatar lives in a navigation-bar item or a page that is not on screen while the card
/// is, so it cannot be the zoom's source on the way back). The avatar itself is not scaled with the page: a still image
/// of it flies on its own, after the page has started to move, from the avatar it was opened from to the card's big
/// avatar and back (`fly`), in the same transition so an interactive swipe drags it along and a cancelled one returns it.
@MainActor
final class AgentCardController: UIHostingController<AnyView> {
    let target: AgentPageTarget
    private let world: World
    private var proxy: UIView?
    /// The still avatar (with a transparent margin all round) and where the avatar itself sits (window coordinates) on the page the
    /// card opened from; nil: the page zooms alone.
    private var flight: (image: UIImage, home: CGRect)?
    /// Transparent margin of the still image, as a fraction of the avatar's side. The sprite cells overhang the box by up to 0.29 of it
    /// (mint's left side), so 0.3 cuts nothing.
    private static let flightMargin: CGFloat = 0.3

    /// The image view's frame for an avatar frame: the avatar's rect grown by the margin, so the avatar lands exactly on `rect`.
    private static func flightFrame(_ rect: CGRect) -> CGRect {
        rect.insetBy(dx: -rect.width * flightMargin, dy: -rect.height * flightMargin)
    }

    init(target: AgentPageTarget, world: World, source: UIView?) {
        self.target = target
        self.world = world
        super.init(rootView: AnyView(EmptyView()))
        rootView = AnyView(AgentCardView(agentId: target.agentId, tab: target.tab)
            .environment(world)
            .environment(\.openRoute) { [weak self] in (self?.navigationController as? RoutePushing)?.push($0) })
        hidesBottomBarWhenPushed = true
        view.backgroundColor = UIColor(Theme.canvas)
        if let source, let window = source.window {
            let home = source.convert(source.bounds, to: window)
            let proxy = UIView(frame: home)
            proxy.isUserInteractionEnabled = false
            proxy.layer.cornerRadius = min(home.width, home.height) / 2
            proxy.layer.cornerCurve = .continuous
            window.addSubview(proxy)
            self.proxy = proxy
            preferredTransition = .zoom { [weak self] _ in self?.proxy }
            // Only a round avatar flies (not a row, not a group's avatars: the card is one agent's).
            if abs(home.width - home.height) < 1, home.width <= 100, !target.sourceId.hasPrefix("chat-group-") {
                // The character draws outside its square (arms, ears, the bounce: `CharacterSprite`), and ImageRenderer keeps only the
                // view's bounds, so it is drawn in a larger transparent canvas; `flightFrame` adds the same margin to both ends.
                let canvas = AvatarSize.profile * (1 + 2 * Self.flightMargin)
                let renderer = ImageRenderer(content: AvatarView(agent: world.agent(target.agentId), size: AvatarSize.profile)
                    .frame(width: canvas, height: canvas).environment(world))
                renderer.scale = source.traitCollection.displayScale
                renderer.isOpaque = false
                if let image = renderer.uiImage { flight = (image, home) }
            }
        }
    }

    @MainActor required dynamic init?(coder aDecoder: NSCoder) { fatalError("init(coder:) is not used") }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        if isMovingToParent { fly(opening: true) }
    }

    /// Going back (button or swipe) spends the target as the pop starts, not after the zoom-back ends: a tap on the same
    /// avatar during that animation is then a new open instead of a no-op. A cancelled swipe puts it back. A card
    /// underneath (opened from a page over another card) becomes the open one again.
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        guard isMovingFromParent else { return }
        let below = navigationController?.viewControllers.compactMap { $0 as? AgentCardController }.last?.target
        let target = target
        if world.agentPage == target { world.agentPage = below }
        transitionCoordinator?.animate(alongsideTransition: nil) { [weak self] context in
            if context.isCancelled, self?.world.agentPage == below { self?.world.agentPage = target }
        }
        fly(opening: false)
    }

    override func didMove(toParent parent: UIViewController?) {
        super.didMove(toParent: parent)
        if parent == nil { proxy?.removeFromSuperview() }
    }

    /// The avatar's own flight inside the page transition: it leaves late (the page moves first) and lands exactly on the
    /// other avatar. Both real avatars are drawn invisible while it is in the air.
    private func fly(opening: Bool) {
        guard let flight, let coordinator = transitionCoordinator else { return }
        let hidden: Set = [target.sourceId, AgentZoomSources.profileId(target.agentId)]
        var flyer: UIImageView?
        coordinator.animate(alongsideTransition: { [weak self] context in
            guard let self, let window = context.containerView.window,
                  let local = AgentZoomSources.profileRect(of: target.agentId, in: self) else { return }
            // The card's own coordinates are its laid-out ones, whatever transform the zoom has put on it.
            let origin = navigationController?.view.convert(CGPoint.zero, to: nil) ?? .zero
            let card = local.offsetBy(dx: origin.x, dy: origin.y)
            let (from, to) = opening ? (flight.home, card) : (card, flight.home)
            let image = UIImageView(image: flight.image)
            image.isUserInteractionEnabled = false
            image.clipsToBounds = false
            UIView.performWithoutAnimation {
                image.frame = Self.flightFrame(from)
                window.addSubview(image)
            }
            AgentZoomSources.setHidden(hidden, true)
            flyer = image
            let duration = context.transitionDuration
            UIView.animate(withDuration: duration * 0.75, delay: duration * 0.25, options: [.curveEaseOut]) { image.frame = Self.flightFrame(to) }
        }, completion: { _ in
            flyer?.removeFromSuperview()
            AgentZoomSources.setHidden(hidden, false)
        })
    }
}
