import SwiftUI
import UIKit

extension View {
    /// This screen uses right swipes itself: the drawer pan doesn't open from it while it's on screen.
    func noDrawerSwipe() -> some View { modifier(NoDrawerSwipe()) }
}

private struct NoDrawerSwipe: ViewModifier {
    @Environment(World.self) private var world
    func body(content: Content) -> some View {
        content
            .onAppear { world.drawerSwipeBlockers += 1 }
            .onDisappear { world.drawerSwipeBlockers -= 1 }
    }
}
