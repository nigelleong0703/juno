import SwiftUI

// MARK: - Ideas (Muse's Ideas tab): what the agents offer, mostly from the daily ideas job

/// One native list: ideas with a draft ready, other ideas, and the For-you suggestions. A tap does the thing (a draft opens
/// first); swipe or long-press a row for "Not interested". Each section shows five and grows by five.
struct IdeasPage: View {
    @Environment(World.self) private var world
    @State private var limits = [Section.ready: 5, .ideas: 5, .suggestions: 5]
    @State private var draft: PlannedIdea?

    private enum Section: String { case ready = "Ready for you", ideas = "Ideas", suggestions = "Suggestions" }

    var body: some View {
        let ideas = world.ideas.filter { world.scope == nil || $0.agentId == world.scope }
        let ready = ideas.filter { $0.prepared?.kind == "draft" && $0.prepared?.ref != nil }
        let others = ideas.filter { idea in !ready.contains { $0.id == idea.id } }
        let cards = world.today.inspiration
        let first: Section = !ready.isEmpty ? .ready : !others.isEmpty ? .ideas : .suggestions
        Group {
            if ideas.isEmpty && cards.isEmpty {
                // Nothing to list: the heading stays where the other tabs have it, the message centres in the rest.
                ScrollView {
                    VStack(spacing: 0) {
                        TabHeading(title: "Ideas").padding(.horizontal, 16)
                        ContentUnavailableView("No ideas yet", systemImage: "lightbulb",
                                               description: Text("Ideas show up here each morning, based on your goals and conversations."))
                            .containerRelativeFrame(.vertical, alignment: .center) { height, _ in height * 0.6 }
                    }
                }
                .scrollBounceBehavior(.basedOnSize)
            } else {
            List {
                section(.ready, ready, first: first) { idea in
                    IdeaRow(idea: idea, subtitle: subtitle(idea, "Draft ready"), hasDraft: true, openDraft: { draft = idea }) { world.acceptIdea(idea) }
                }
                section(.ideas, others, first: first) { idea in
                    IdeaRow(idea: idea, subtitle: subtitle(idea, idea.why)) { world.acceptIdea(idea) }
                }
                section(.suggestions, cards, first: first) { card in
                    InspirationRow(card: card).dismissible { world.dismiss(card) }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            }
        }
        .background(Theme.canvas)
        .overlay(alignment: .top) {
            if let toast = world.proactiveToast {
                HStack(spacing: 12) {
                    Text(toast.text).text(.base, .medium).foregroundStyle(Theme.fg).frame(maxWidth: .infinity, alignment: .leading)
                    if toast.ruleId != nil {
                        Button("Undo") { world.undoProactiveRule() }.text(.base, .semibold).foregroundStyle(Theme.fg)
                            .accessibilityIdentifier("idea-undo")
                    }
                }
                .toastChrome()
            }
        }
        .animation(.snappy, value: world.proactiveToast)
        .tabHeader("Ideas")
        .onChange(of: world.scope) { limits = [.ready: 5, .ideas: 5, .suggestions: 5] }
        .sheet(item: $draft) { idea in IdeaDraftSheet(idea: idea).junoSheetPresentation(long: true) }
    }

    private func subtitle(_ idea: PlannedIdea, _ detail: String?) -> String {
        [world.agent(idea.agentId)?.name, detail].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " \u{00B7} ")
    }

    /// The section's header, up to `limit` cards and "Show more" as plain list rows (clear, no rules), like the Feed's.
    @ViewBuilder private func section<Item: Identifiable, Row: View>(_ id: Section, _ items: [Item], first: Section, @ViewBuilder row: @escaping (Item) -> Row) -> some View {
        let limit = limits[id] ?? 5
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                // The page's heading rides on the first section.
                if id == first { TabHeading(title: "Ideas").padding(.bottom, 12) }
                Text(id.rawValue).text(.sm, .semibold).foregroundStyle(Theme.fgMuted).padding(.horizontal, 4)
            }
            .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 0, trailing: 16))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
            ForEach(items.prefix(limit)) { item in
                row(item)
                    .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
            if items.count > limit {
                ShowMore(shown: limit, total: items.count) { limits[id] = limit + 5 }
                    .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
        }
    }
}

private extension View {
    /// Trailing swipe and context menu "Not interested".
    func dismissible(_ action: @escaping () -> Void) -> some View {
        swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button(role: .destructive) { withAnimation { action() } } label: { Label("Not interested", systemImage: "hand.thumbsdown") }
        }
        .contextMenu {
            Button(role: .destructive) { withAnimation { action() } } label: { Label("Not interested", systemImage: "hand.thumbsdown") }
        }
    }
}

/// An idea: the agent's avatar, the idea, one muted line, a chevron.
private struct IdeaRow: View {
    @Environment(World.self) private var world
    var idea: PlannedIdea
    var subtitle: String
    var hasDraft = false
    var openDraft: () -> Void = {}
    var action: () -> Void

    var body: some View {
        let text = idea.text ?? idea.prompt ?? ""
        var buttons = [CardButton(label: CardButton.label(.notNow, for: text), kind: .ghost) { feedback("not_now") },
                       CardButton(label: CardButton.label(.doIt, for: text), run: action)]
        if hasDraft { buttons.insert(CardButton(label: CardButton.label(.draft, for: text), kind: .link, run: openDraft), at: 0) }
        let less = Menu("Less like this") { lessChoices }
            .text(.sm).foregroundStyle(Theme.fgMuted).frame(minHeight: 32)
            .accessibilityIdentifier("idea-less-\(idea.id)")
        return SuggestionCard(title: text, subtitle: subtitle, buttons: buttons, extra: AnyView(less)) {
            AvatarView(agent: world.agent(idea.agentId), size: AvatarSize.md)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button(role: .destructive) { feedback("not_now") } label: { Label("Not now", systemImage: "clock.badge.xmark") }
        }
        .contextMenu {
            Button(role: .destructive) { feedback("not_now") } label: { Label("Not now", systemImage: "clock.badge.xmark") }
            lessChoices
        }
        .accessibilityIdentifier("idea-\(idea.id)")
    }

    /// The three ways to say "less", written out so there is no guessing what each one does.
    @ViewBuilder private var lessChoices: some View {
        Button("Fewer about this topic") { feedback("less", scope: "topic") }
        Button("Fewer ideas like this") { feedback("less", scope: "type") }
        Button("Never suggest this", role: .destructive) { feedback("never", scope: "topic") }
    }

    private func feedback(_ action: String, scope: String? = nil) {
        withAnimation { world.ideaFeedback(idea.id, action, scope: scope) }
    }
}

/// The draft an idea came with, read from the user's home when the sheet opens.
private struct IdeaDraftSheet: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    let idea: PlannedIdea
    @State private var text: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(text ?? "…").text(.base).foregroundStyle(Theme.fg).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(16)
            }
            .background(Theme.canvas)
            .pageHeader(idea.prepared?.label ?? "Draft")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Use it") { world.acceptIdea(idea); dismiss() } }
            }
        }
        .task {
            guard let path = idea.prepared?.ref else { return }
            text = await world.ideaDraft(path) ?? "This draft is no longer there."
        }
    }
}
