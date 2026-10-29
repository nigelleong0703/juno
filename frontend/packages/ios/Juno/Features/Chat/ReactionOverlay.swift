import SwiftUI
import UIKit

// WhatsApp-style long press: the page dims and blurs, the bubble lifts in place, a pill of emoji floats above it and
// the actions sit below. Presented over the whole screen by the chat list (a context menu cannot host a bar).

struct ReactionAction: Identifiable {
    var id: String { title }
    var title: String
    var symbol: String
    var destructive = false
    var run: () -> Void
}

struct ReactionSheet: View {
    let snapshot: UIImage
    /// The bubble's frame on screen.
    let frame: CGRect
    let trailing: Bool
    let mine: String?
    let actions: [ReactionAction]
    let onReact: (String?) -> Void
    let onClose: () -> Void

    @State private var lifted = false
    @State private var shown = false
    @State private var more = false

    private static let extra = ["🔥", "🎉", "😍", "🤔", "👀", "💯", "✅", "👎", "😅", "🙌"]

    var body: some View {
        let screen = UIScreen.main.bounds
        let barH: CGFloat = 52, gap: CGFloat = 10
        let menuH = CGFloat(actions.count) * 46 + CGFloat(max(0, actions.count - 1))
        let msgHeight = min(frame.height, screen.height - 200 - barH - menuH - 3 * gap)
        let highest = 70 + barH + gap
        let lowest = screen.height - 40 - menuH - gap - msgHeight
        let restTop = min(max(frame.minY, highest), lowest)
        let msgTop = lifted ? restTop : frame.minY
        let edgeX = trailing ? frame.maxX : frame.minX
        let barW: CGFloat = min(screen.width - 32, CGFloat(more ? 6 + Self.extra.count : 7) * 44 + 12)
        let barX = trailing ? max(edgeX - barW / 2, 16 + barW / 2) : min(edgeX + barW / 2, screen.width - 16 - barW / 2)
        let menuW: CGFloat = 220
        let menuX = trailing ? max(edgeX - menuW / 2, 16 + menuW / 2) : min(edgeX + menuW / 2, screen.width - 16 - menuW / 2)
        ZStack(alignment: .topLeading) {
            Rectangle().fill(.ultraThinMaterial)
                .overlay(Color.black.opacity(0.15))
                .opacity(lifted ? 1 : 0)
                .contentShape(.rect)
                .onTapGesture { close() }
            // Cropped to the room there is (a long reply), anchored at its top.
            Image(uiImage: snapshot)
                .frame(width: frame.width, height: msgHeight, alignment: .topLeading)
                .clipShape(.rect(cornerRadius: Radius.xxl))
                .scaleEffect(lifted ? 1.02 : 1)
                .shadow(color: .black.opacity(lifted ? 0.15 : 0), radius: 14, y: 6)
                .position(x: frame.midX, y: msgTop + msgHeight / 2)
                .allowsHitTesting(false)
            // The emoji pill: six reactions and a "+" for more.
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 0) {
                    ForEach(Array((reactionChoices + (more ? Self.extra : [])).enumerated()), id: \.element) { i, e in
                        Button {
                            onReact(mine == e ? nil : e)
                            close()
                        } label: {
                            Text(e).emojiSize(28)
                                .frame(width: 44, height: 44)
                                .background(mine == e ? Theme.muted : .clear, in: .circle)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(e)
                        .scaleEffect(shown ? 1 : 0.3)
                        .opacity(shown ? 1 : 0)
                        .animation(.spring(response: 0.32, dampingFraction: 0.62).delay(0.04 * Double(min(i, 6))), value: shown)
                    }
                    if !more {
                        Button { withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) { more = true } } label: {
                            Image(systemName: "plus").text(.md, .semibold).foregroundStyle(Theme.fgMuted)
                                .frame(width: 32, height: 32).background(Theme.muted, in: .circle)
                                .frame(width: 44, height: 44)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("More reactions")
                    }
                }
                .padding(.horizontal, 6)
            }
            .frame(width: barW, height: barH)
            .glassSurface(.capsule)
            .scaleEffect(shown ? 1 : 0.1, anchor: trailing ? .bottomTrailing : .bottomLeading)
            .opacity(shown ? 1 : 0)
            .position(x: barX, y: msgTop - gap - barH / 2)
            // The actions.
            VStack(spacing: 0) {
                ForEach(Array(actions.enumerated()), id: \.element.id) { i, a in
                    if i > 0 { Divider() }
                    Button { close(); a.run() } label: {
                        HStack {
                            Text(a.title).text(.md).foregroundStyle(a.destructive ? Theme.danger : Theme.fg)
                            Spacer()
                            Image(systemName: a.symbol).foregroundStyle(a.destructive ? Theme.danger : Theme.fg)
                        }
                        .padding(.horizontal, 16).frame(height: 46).contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(width: menuW)
            .glassSurface(.rect(cornerRadius: 18))
            .scaleEffect(shown ? 1 : 0.1, anchor: trailing ? .topTrailing : .topLeading)
            .opacity(shown ? 1 : 0)
            .position(x: menuX, y: msgTop + msgHeight + gap + menuH / 2)
        }
        .ignoresSafeArea()
        .onAppear {
            withAnimation(.spring(response: 0.35, dampingFraction: 0.78)) { lifted = true }
            withAnimation(.spring(response: 0.38, dampingFraction: 0.7).delay(0.06)) { shown = true }
        }
    }

    private func close() {
        withAnimation(.spring(response: 0.25, dampingFraction: 0.9)) { shown = false; lifted = false }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(220))
            onClose()
        }
    }
}
