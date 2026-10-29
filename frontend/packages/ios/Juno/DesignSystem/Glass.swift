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
