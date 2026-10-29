import SwiftUI

/// Full-screen search over the sidebar (Claude iOS): a field and Cancel on top; recent chats while the field is
/// empty, matching agents and chats once it isn't. A result closes the cover and the drawer and opens as the sidebar does.
struct SearchPage: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var expanded: Set<String> = []
    @FocusState private var focused: Bool

    private let limit = 5

    var body: some View {
        let q = query.trimmingCharacters(in: .whitespaces)
        let agents = world.agents.filter { ($0.name ?? "").localizedCaseInsensitiveContains(q) }
        // Platform groups and strangers' DMs are searchable too (they are not in "Recents").
        let chats = world.sortedConversations.filter { world.title(of: $0).localizedCaseInsensitiveContains(q) }
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(Theme.fgSubtle)
                    TextField("Search", text: $query).focused($focused).text(.lg)
                        .submitLabel(.search).autocorrectionDisabled()
                }
                .padding(.horizontal, 14).frame(height: 40)
                .background(Theme.muted, in: .capsule)
                Button("Cancel") { dismiss() }.foregroundStyle(Theme.fg)
            }
            .padding(.horizontal, 16).padding(.vertical, 8)

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if q.isEmpty {
                        section("Recents", id: "recents", items: world.recentConversations, row: chatRow)
                    } else if agents.isEmpty && chats.isEmpty {
                        Text("No results").text(.lg).foregroundStyle(Theme.fgMuted)
                            .padding(.leading, 21).padding(.top, 22)
                    } else {
                        section("Agents", id: "agents", items: agents, row: agentRow)
                        section("Chats", id: "chats", items: chats, row: chatRow)
                    }
                }
                .padding(.horizontal, 10).padding(.bottom, 16)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
        }
        .background(Theme.canvas)
        .onAppear { focused = true }
    }

    @ViewBuilder
    private func section<Item: Identifiable>(_ title: String, id: String, items: [Item], row: @escaping (Item) -> some View) -> some View {
        if !items.isEmpty {
            let all = expanded.contains(id)
            SidebarHeader(title)
            ForEach(all ? items : Array(items.prefix(limit))) { row($0) }
            if !all && items.count > limit {
                SidebarRow(selected: false) { withAnimation(.snappy) { _ = expanded.insert(id) } } label: {
                    SidebarRowLabel { Image(systemName: "chevron.down").text(.base, .medium) } text: { Text("Show all") }
                }
            }
        }
    }

    private func agentRow(_ agent: Agent) -> some View {
        SidebarRow(selected: false) { open { world.openFromSidebar(agent) } } label: {
            SidebarRowLabel { AvatarView(agent: agent, size: 22) } text: { Text(agent.name ?? "") }
        }
    }

    private func chatRow(_ c: Conversation) -> some View {
        SidebarRow(selected: false) { open { world.openChat(c.id) } } label: {
            SidebarRowLabel { Image(systemName: "bubble.left").text(.lg) } text: { Text(world.title(of: c)) }
        }
    }

    private func open(_ action: @escaping () -> Void) {
        dismiss()
        withAnimation(.snappy(duration: 0.28)) { action() }
    }
}
