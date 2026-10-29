import SwiftUI
import UIKit

/// Row heights, worked out BEFORE a row is shown (Signal's CVRenderState / Telegram's ListView item nodes): the
/// list gives ChatLayout `.exact` sizes, so a row never resizes after it appears and the content height never
/// jumps while the reader looks at it.
///
/// A height is measured with one reusable `UIHostingController` that hosts the same `ChatRow` with the same
/// environment, at the list's width. One slot per row id holds the (revision, width) it was measured for; it is
/// stale when the row's content revision changes (new item version, reaction, run step, ...) or the width does.
@MainActor
final class RowHeights {
    static let shared = RowHeights()

    private struct Slot { var revision: Int; var width: CGFloat; var height: CGFloat }
    private var slots: [String: Slot] = [:]
    private let host: UIHostingController<AnyView> = {
        let host = UIHostingController(rootView: AnyView(EmptyView()))
        host.safeAreaRegions = []
        host.view.backgroundColor = .clear
        return host
    }()
    /// Rows kept at most (a few chats' windows); past it the oldest half goes.
    private let capacity = 3000
    private var order: [String] = []

    func height(for entry: ChatEntry, width: CGFloat) -> CGFloat? {
        guard let slot = slots[entry.id], slot.revision == entry.revision, abs(slot.width - width) < 0.5 else { return nil }
        return slot.height
    }

    func set(_ height: CGFloat, for entry: ChatEntry, width: CGFloat) {
        if slots[entry.id] == nil {
            order.append(entry.id)
            if order.count > capacity {
                for id in order.prefix(capacity / 2) { slots[id] = nil }
                order.removeFirst(capacity / 2)
            }
        }
        slots[entry.id] = Slot(revision: entry.revision, width: width, height: height)
    }

    /// Markdown rows (Textual) build their text one update after the first pass, so they are measured in a host that is
    /// given a runloop turn before it is read; every other row is measured in the same call, synchronously.
    private let textHost: UIHostingController<AnyView> = {
        let host = UIHostingController(rootView: AnyView(EmptyView()))
        host.safeAreaRegions = []
        return host
    }()
    private var busy = false

    /// SwiftUI only runs its follow-up updates for a view in a window: the host sits far off screen in the key window.
    private func attachTextHost() {
        guard textHost.view.superview == nil,
              let window = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first else { return }
        textHost.view.isUserInteractionEnabled = false
        textHost.view.isAccessibilityElement = false
        textHost.view.accessibilityElementsHidden = true
        window.addSubview(textHost.view)
    }

    private func turn() async { await withCheckedContinuation { c in DispatchQueue.main.async { c.resume() } } }

    private func size(of entry: ChatEntry, context: ChatContext, width: CGFloat, in host: UIHostingController<AnyView>) -> CGFloat {
        if host !== textHost { host.view.frame = CGRect(x: 0, y: 0, width: width, height: 10_000) }
        host.view.layoutIfNeeded()
        let size = host.sizeThatFits(in: CGSize(width: width, height: 10_000))
        host.rootView = AnyView(EmptyView())
        return ceil(size.height)
    }

    /// The row's height at `width`, measured now (about a millisecond for a bubble) and remembered. Not for markdown.
    @discardableResult
    func measure(_ entry: ChatEntry, context: ChatContext, width: CGFloat) -> CGFloat {
        if let known = height(for: entry, width: width) { return known }
        // `.id`: a hosted row's @State (an expanded step, a draft) must not carry over from the previous measurement.
        host.rootView = AnyView(chatRowContent(entry, context: context, width: width).id(entry.id))
        let height = size(of: entry, context: context, width: width, in: host)
        set(height, for: entry, width: width)
        return height
    }

    /// Measures rows in order without holding the main thread for more than a few milliseconds at a time, until
    /// `enough` says so (or all are done). One caller at a time.
    func measureAll(_ entries: [ChatEntry], context: ChatContext, width: CGFloat, enough: (() -> Bool)? = nil) async {
        while busy { await turn() }
        busy = true
        defer { busy = false }
        var sliceStart = CACurrentMediaTime()
        for entry in entries {
            if enough?() == true { return }
            if height(for: entry, width: width) != nil { continue }
            if entry.item?.type == "agent_message" {
                attachTextHost()
                textHost.rootView = AnyView(chatRowContent(entry, context: context, width: width).id(entry.id))
                textHost.view.frame = CGRect(x: -20_000, y: 0, width: width, height: 10_000)
                textHost.view.layoutIfNeeded()
                await turn()
                set(size(of: entry, context: context, width: width, in: textHost), for: entry, width: width)
            } else {
                measure(entry, context: context, width: width)
            }
            if CACurrentMediaTime() - sliceStart > 0.006 { await turn(); sliceStart = CACurrentMediaTime() }
        }
    }
}

/// The row exactly as a cell hosts it. The cell adds the callbacks; a measurement has none.
func chatRowContent(_ entry: ChatEntry, context: ChatContext, width: CGFloat,
                    bubble: ((CGRect) -> Void)? = nil, resized: ((CGFloat) -> Void)? = nil, touched: (() -> Void)? = nil) -> some View {
    ChatRow(entry: entry, conversationId: context.conversationId, isGroup: context.isGroup)
        .environment(context.world)
        .environment(\.agentAccent, context.accent)
        .environment(\.chatAvailableWidth, max(0, width - 32))
        .environment(\.openRoute, context.openRoute)
        .environment(\.reportBubbleFrame, bubble)
        .environment(\.rowResized, resized)
        .environment(\.rowTouched, touched)
}
