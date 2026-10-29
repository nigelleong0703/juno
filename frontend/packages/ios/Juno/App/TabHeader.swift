import SwiftUI

/// The Chats home's header, for the SwiftUI tabs (Feed, Ideas, Goals, Library): no band behind the bar, a large heading
/// at the top of the content (`TabHeading`, styled like the greeting), and the page's name in the bar's centre that
/// fades in once the heading has scrolled away. ☰ comes from `SidebarButton`; the agent scope is the trailing glass button.
/// Apply to the page's scroll view (List or ScrollView) itself, so the offset it reads is that scroll view's.
struct TabBarHeader: ViewModifier {
    var title: String
    @State private var scrolled: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .onScrollGeometryChange(for: CGFloat.self) { max(0, $0.contentOffset.y + $0.contentInsets.top) } action: { _, new in scrolled = new }
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackgroundVisibility(.hidden, for: .navigationBar)
            .scrollEdgeEffectStyle(.soft, for: .top)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text(title).font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.fg)
                        .opacity(min(1, max(0, (scrolled - 36) / 36)))
                        .accessibilityHidden(true)
                }
                ToolbarItem(placement: .topBarTrailing) { AgentScopeButton(compact: true) }
            }
    }
}

/// The same bar for a pushed page or a sheet's root: transparent, no hairline, the system back (or the caller's close)
/// button, and the page's name in the centre. A page with its own heading in the content passes `revealAfter` (the
/// offset where that heading has scrolled away) so the name fades in then; without it the name is always shown.
struct PageBarHeader: ViewModifier {
    var title: String
    var revealAfter: CGFloat?
    @State private var scrolled: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .modifier(OffsetReader(enabled: revealAfter != nil, scrolled: $scrolled))
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackgroundVisibility(.hidden, for: .navigationBar)
            .scrollEdgeEffectStyle(.soft, for: .top)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text(title).font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.fg).lineLimit(1)
                        .opacity(revealAfter.map { min(1, max(0, (scrolled - $0) / 36)) } ?? 1)
                }
                .sharedBackgroundVisibility(.hidden)
            }
    }
}

private struct OffsetReader: ViewModifier {
    var enabled: Bool
    @Binding var scrolled: CGFloat
    func body(content: Content) -> some View {
        if enabled {
            content.onScrollGeometryChange(for: CGFloat.self) { max(0, $0.contentOffset.y + $0.contentInsets.top) } action: { _, new in scrolled = new }
        } else { content }
    }
}

extension View {
    func tabHeader(_ title: String) -> some View { modifier(TabBarHeader(title: title)) }
    /// The pushed-page / sheet-root bar. Apply to the page's scroll view when passing `revealAfter`.
    func pageHeader(_ title: String, revealAfter: CGFloat? = nil) -> some View { modifier(PageBarHeader(title: title, revealAfter: revealAfter)) }
}

/// The page's name as the heading, the size and weight of the Chats greeting. The caller supplies the side insets.
struct TabHeading: View {
    var title: String
    var body: some View {
        Text(title).text(.xxl, .bold).foregroundStyle(Theme.fg).lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 8).padding(.bottom, 8)
            .accessibilityAddTraits(.isHeader)
    }
}
