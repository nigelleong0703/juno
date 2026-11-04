import SwiftUI

extension View {
    /// The floating Liquid Glass surface used by popover bars and menus.
    func glassSurface<S: Shape>(_ shape: S) -> some View { glassEffect(.regular, in: shape) }

    /// Emoji drawn at a fixed point size (reactions), not scaled with text styles.
    func emojiSize(_ size: CGFloat) -> some View { font(.system(size: size)) }
}

/// A UIKit Liquid Glass layer for a surface that holds a `Menu` (the composer): SwiftUI `glassEffect` on or beside a
/// Menu makes iOS 26 morph the glass into the menu, and a SwiftUI glass sibling draws over the content.
struct GlassBackground: UIViewRepresentable {
    var cornerRadius: CGFloat
    func makeUIView(context: Context) -> UIVisualEffectView {
        let view = UIVisualEffectView(effect: UIGlassEffect(style: .regular))
        view.cornerConfiguration = .corners(radius: .fixed(cornerRadius))
        return view
    }
    func updateUIView(_ view: UIVisualEffectView, context: Context) {
        view.cornerConfiguration = .corners(radius: .fixed(cornerRadius))
    }
}

/// A 44pt glass circle with a 17pt symbol: the size of the system ☰ in the navigation bar.
struct RoundGlassButton: View {
    var symbol: String
    var label: String
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).text(.lg, .medium).foregroundStyle(Theme.fg)
                .frame(width: 44, height: 44)
                .glassEffect(.regular.interactive(), in: .circle)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// A 76pt call control with a 30pt symbol and its label underneath. End call is a red fill with a white symbol.
struct CallControl: View {
    let symbol: String
    let label: String
    var destructive = false
    let action: () -> Void

    private let diameter: CGFloat = 76

    var body: some View {
        Button(action: action) {
            VStack(spacing: 8) {
                Image(systemName: symbol).font(.system(size: 30, weight: .medium))
                    .foregroundStyle(destructive ? Color.white : Theme.fg)
                    .frame(width: diameter, height: diameter)
                    .background { if destructive { Circle().fill(Theme.danger) } }
                    .glassEffect(destructive ? .identity : .regular.interactive(), in: .circle)
                Text(label).font(.footnote.weight(.medium)).foregroundStyle(Theme.fgMuted)
                    .lineLimit(2).multilineTextAlignment(.center)
            }
            .frame(minWidth: diameter, maxWidth: 104)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}
