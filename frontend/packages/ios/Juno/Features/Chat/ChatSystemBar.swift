import ChatLayout
import SwiftUI
import UIKit

/// The chat's top bar content, hosted in UIKit so its glass descendants register with the list's scroll edge
/// effect (the system soft edge under the header).
struct ChatSystemBar<Content: View>: UIViewControllerRepresentable {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    func makeUIViewController(context: Context) -> Controller {
        let controller = Controller(rootView: content)
        controller.sizingOptions = .intrinsicContentSize
        return controller
    }

    func updateUIViewController(_ controller: Controller, context: Context) {
        controller.rootView = content
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiViewController: Controller, context: Context) -> CGSize? {
        guard let width = proposal.width else { return nil }
        return uiViewController.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude))
    }

    final class Controller: UIHostingController<Content> {
        private let interaction = UIScrollEdgeElementContainerInteraction()

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .clear
            safeAreaRegions = []
            // The list is flipped: its bottom edge is the visual top.
            interaction.edge = .bottom
            view.addInteraction(interaction)
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            guard let window = view.window, let list = findChatList(in: window), interaction.scrollView !== list else { return }
            interaction.scrollView = list
            list.bottomEdgeEffect.isHidden = false
            list.bottomEdgeEffect.style = .soft
        }
    }
}

func findChatList(in view: UIView) -> UICollectionView? {
    if let list = view as? UICollectionView, list.collectionViewLayout is CollectionViewChatLayout { return list }
    for child in view.subviews { if let found = findChatList(in: child) { return found } }
    return nil
}

/// The composer's side of the flip: it is the list's top edge (the visual bottom).
@MainActor final class ChatComposerEdge {
    private let interaction = UIScrollEdgeElementContainerInteraction()

    init(view: UIView) {
        interaction.edge = .top
        view.addInteraction(interaction)
    }

    func attach(in window: UIWindow?) {
        guard let window, let list = findChatList(in: window), interaction.scrollView !== list else { return }
        interaction.scrollView = list
        list.topEdgeEffect.isHidden = true
    }
}
