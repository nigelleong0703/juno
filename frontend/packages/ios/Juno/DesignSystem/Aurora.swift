import SwiftUI

/// Gemini-style glow: large, heavily blurred blobs in the given colours that melt into the page. Decoration only.
/// (The Home screen's background; now behind the Today header.)
struct AuroraBackground: View {
    var colors: [Color]
    var height: CGFloat = 460
    var body: some View {
        let palette = colors.isEmpty ? [Color.purple, .teal, .orange] : colors
        ZStack {
            ForEach(Array(palette.prefix(3).enumerated()), id: \.offset) { i, c in
                Circle().fill(c)
                    .frame(width: height * 0.65, height: height * 0.65)
                    .offset(x: [-120, 120, 0][i], y: [-height * 0.09, -height * 0.15, height * 0.13][i])
            }
        }
        .blur(radius: 70)
        .opacity(0.55)
        .frame(height: height).frame(maxWidth: .infinity)
        .mask(LinearGradient(colors: [.black, .black.opacity(0.6), .clear], startPoint: .top, endPoint: .bottom))
        .allowsHitTesting(false)
    }
}
