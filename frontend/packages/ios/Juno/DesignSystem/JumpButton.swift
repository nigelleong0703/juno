import SwiftUI

/// The round glass "jump to latest" button of a chat list.
struct JumpButton: View {
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "chevron.down").font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.fg)
                .frame(width: 40, height: 40)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .circle)
        .accessibilityLabel("Jump to latest")
    }
}
