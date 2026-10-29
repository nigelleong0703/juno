import SwiftUI

/// Memory (Team, owner-approved 2026-10-26 "No boxes"): what the agents remember, written as a few paragraphs. Under the aurora
/// wash comes the title "What your team knows about you", the agents' small avatars with "From your chats · tidied …", the
/// "N things to check ›" line while items wait, and then one paragraph per topic: a small caps label (with the avatars of the
/// agents that wrote items in it) and the summary the nightly job wrote (`segments` of `GET /v1/memory/topics`). A phrase that
/// states one memory item is dotted-underlined, and a tap opens that item's sheet (`MemoryFactSheet`). While a topic has no
/// summary its items' texts stand in for it, each one tappable. Search is the bar's magnifier (`MemorySearchPage`). The prose
/// has no rows, so no swipe or long press: the sheet alone carries the editable text, Who can hear it, Keep private and Forget. Each change
/// shows at once and is put back if the server refuses it (`TeamMemoryStore`).
struct TeamMemory: View {
    @Environment(World.self) private var world

    /// The order the paragraphs come in (the server's order has people before agents).
    static let topicOrder = ["identity", "health", "work", "plans", "preferences", "agents", "people", "home", "other"]

    var body: some View {
        let store = world.teamMemory
        VStack(alignment: .leading, spacing: 8) {
            Text("What your team knows about you")
                .font(.system(size: 30, weight: .bold)).foregroundStyle(Theme.fg)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            HStack(spacing: 8) {
                MemoryAvatarStack(agents: Array(world.agents.prefix(3)), size: 24)
                Text(Self.fromLine(store.topics.compactMap(\.updatedAt).max())).text(.base).foregroundStyle(Theme.fgMuted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .teamRow(separator: false, vertical: 8)
        if store.refused {
            Text("That change was not saved, so it is back as it was.").text(.sm).foregroundStyle(Theme.warning).teamRow(separator: false)
        }
        if !store.review.isEmpty {
            RouteLink(route: .memoryReview) {
                HStack(spacing: 8) {
                    Circle().fill(Theme.warning).frame(width: 7, height: 7)
                    Text(store.review.count == 1 ? "1 thing to check" : "\(store.review.count) things to check").text(.md).foregroundStyle(Theme.fg)
                    Image(systemName: "chevron.right").text(.xxs, .bold).foregroundStyle(Theme.fgSubtle)
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 4)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("memory-review")
            .teamRow(separator: false, vertical: 2)
        }
        TeamListView(load: store.topicLoad, emptyTitle: "Nothing remembered yet", offlineText: "Memory is unavailable right now.") { topics in
            ForEach(Self.ordered(topics), id: \.topic) { topic in
                TopicProse(topic: topic)
                    .accessibilityIdentifier("memory-topic-\(topic.topic ?? "other")")
                    .teamRow(separator: false, vertical: 13)
            }
        }
    }

    static func ordered(_ topics: [Contract.MemoryTopicView]) -> [Contract.MemoryTopicView] {
        topics.sorted { (topicOrder.firstIndex(of: $0.topic ?? "other") ?? topicOrder.count) < (topicOrder.firstIndex(of: $1.topic ?? "other") ?? topicOrder.count) }
    }

    /// "From your chats · tidied today": when the nightly job last wrote a summary.
    static func fromLine(_ tidied: Date?) -> String {
        guard let tidied else { return "From your chats" }
        let when = Calendar.current.isDateInToday(tidied) ? "today"
            : Calendar.current.isDateInYesterday(tidied) ? "yesterday"
            : tidied.formatted(.dateTime.month(.abbreviated).day())
        return "From your chats \u{00B7} tidied \(when)"
    }
}

/// Agents' small characters, overlapping. Decoration (the text beside them says what they are).
private struct MemoryAvatarStack: View {
    var agents: [Agent]
    var size: CGFloat

    var body: some View {
        HStack(spacing: -size * 0.28) {
            ForEach(agents) { AvatarView(agent: $0, size: size) }
        }
        .accessibilityHidden(true)
    }
}

/// One topic: its small caps label and the summary as prose. Phrases that name an item are dotted-underlined links that open
/// the item's sheet through `openFact`.
private struct TopicProse: View {
    @Environment(World.self) private var world
    @Environment(\.openFact) private var openFact
    var topic: Contract.MemoryTopicView

    var body: some View {
        let items = loadedItems
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text((topic.label ?? "").uppercased()).font(.system(size: 12, weight: .semibold)).tracking(1.2).foregroundStyle(Theme.fgSubtle)
                MemoryAvatarStack(agents: writers(of: items), size: 20)
            }
            Text(prose(items))
                .font(.system(size: 21)).lineSpacing(5).foregroundStyle(Theme.fg).tint(Theme.fg)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .environment(\.openURL, OpenURLAction { url in
                    guard let id = MemoryFactLink.itemId(url) else { return .discarded }
                    openFact?(id)
                    return .handled
                })
        }
    }

    private var loadedItems: [Contract.MemoryItemView] {
        if case .loaded(let rows) = world.teamMemory.items(in: topic.topic ?? "other") { return rows }
        return []
    }

    /// Up to three agents that wrote an item of this topic, in the order they first appear.
    private func writers(of items: [Contract.MemoryItemView]) -> [Agent] {
        var seen = Set<String>()
        let ids = items.compactMap(\.agentId).filter { seen.insert($0).inserted }
        return Array(ids.compactMap { world.agent($0) }.prefix(3))
    }

    /// The summary's pieces, a phrase with an `itemId` as a link; with no summary yet, the items' texts as sentences, each a link.
    private func prose(_ items: [Contract.MemoryItemView]) -> AttributedString {
        let summary = (topic.summary ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        var pieces: [(text: String, itemId: String?)] = []
        if !summary.isEmpty {
            let segments = topic.segments ?? []
            pieces = segments.isEmpty ? [(summary, nil)] : segments.map { ($0.text ?? "", $0.itemId) }
        } else {
            for (index, item) in items.enumerated() {
                if index > 0 { pieces.append((" ", nil)) }
                pieces.append((MemoryFactLink.sentence(item.text ?? ""), item.id))
            }
        }
        var out = AttributedString()
        for piece in pieces {
            var run = AttributedString(piece.text)
            if let id = piece.itemId, let url = MemoryFactLink.url(id) {
                run.link = url
                run.underlineStyle = Text.LineStyle(pattern: .dot, color: Theme.fg.opacity(0.35))
            }
            out += run
        }
        return out
    }
}

/// A phrase's link: `juno-fact://fact?id=<item id>`, read back by the prose's `openURL`.
enum MemoryFactLink {
    static func url(_ itemId: String) -> URL? {
        var parts = URLComponents()
        parts.scheme = "juno-fact"
        parts.host = "fact"
        parts.queryItems = [URLQueryItem(name: "id", value: itemId)]
        return parts.url
    }

    static func itemId(_ url: URL) -> String? {
        guard url.scheme == "juno-fact" else { return nil }
        return URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "id" }?.value
    }

    /// An item's text as a sentence of its own.
    static func sentence(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let last = trimmed.last else { return trimmed }
        return ".!?\u{3002}\u{FF01}\u{FF1F}".contains(last) ? trimmed : trimmed + "."
    }
}

enum MemoryMeta {
    /// "<where it was said> · <who may hear it>", both as the server words them.
    static func line(_ item: Contract.MemoryItemView) -> String {
        [item.saidIn?.label, item.audience?.label].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " \u{00B7} ")
    }

    /// The group's name when the item may be heard in a group, else nil.
    static func group(_ item: Contract.MemoryItemView) -> String? {
        guard item.audience?.kind == "group", let label = item.audience?.label, !label.isEmpty else { return nil }
        return label
    }

    /// What the server calls the place of an item no conversation is known for; it says nothing about where.
    static let earlierMemory = "Earlier memory"

    /// The person's own words (`quote`), or nil when the item has none.
    static func quote(_ item: Contract.MemoryItemView) -> String? {
        item.quote?.text.flatMap { $0.isEmpty ? nil : $0 }
    }

    /// Under the quote: "Telegram · 12 Oct 2026", where (unless "Earlier memory") and when the quote was said. Without a quote it
    /// is the line "Said by you · Telegram · 12 Oct 2026": who, where and when the item was made.
    static func provenance(_ item: Contract.MemoryItemView) -> String {
        let place = item.saidIn?.label.flatMap { $0.isEmpty || $0 == earlierMemory ? nil : $0 }
        if quote(item) != nil {
            return [place, item.quote?.at?.formatted(date: .abbreviated, time: .omitted)].compactMap { $0 }.joined(separator: " \u{00B7} ")
        }
        // The person being helped is "you" here, whatever name their own person carries (it can still be the "Owner" fallback).
        let who = item.saidBy?.kind == "owner" ? "Said by you" : item.saidBy?.name.map { "Said by \($0)" }
        return [who, place, item.createdAt?.formatted(date: .abbreviated, time: .omitted)].compactMap { $0 }.joined(separator: " \u{00B7} ")
    }
}

// MARK: - The fact sheet

/// The item a tapped phrase (or search result) names, to present its sheet.
struct FactPick: Identifiable, Hashable {
    var id: String
}

extension EnvironmentValues {
    /// Set by the screen that presents the fact sheet: opens the sheet of the item with this id.
    @Entry var openFact: ((String) -> Void)? = nil
}

extension View {
    /// Presents `MemoryFactSheet` for the picked item (a `JunoSheet`, which brings its own presentation).
    func memoryFactSheet(_ pick: Binding<FactPick?>) -> some View {
        sheet(item: pick) { MemoryFactSheet(itemId: $0.id) }
    }
}

/// One fact in the app's sheet format (`JunoSheet`: title "Memory", Close on the left, Save on the right, enabled once the text
/// changed): the text as an editable field (Save sends only the text), who said it and where with the writing agent's avatar,
/// "Who can hear it" (segmented), the Keep private switch (= sensitive) and Forget (after a confirm). The audience and the
/// switch apply as soon as they are changed. The sheet closes by itself when the item is gone.
private struct MemoryFactSheet: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var itemId: String
    @State private var draft = ""
    @State private var confirmForget = false

    var body: some View {
        let store = world.teamMemory
        let item = store.item(itemId)
        let change = item.flatMap(textChange)
        JunoSheet(icon: "brain", title: "Memory", primary: "Save", primaryEnabled: change != nil, cancel: "Close", id: "memory-fact",
                  onPrimary: {
                      if let item, let change { store.edit(world, item, text: change, audience: nil, sensitive: nil) }
                      dismiss()
                  },
                  onCancel: { dismiss() }) {
            if let item { content(item, store) }
        }
        .onAppear { draft = item?.text ?? "" }
        .onChange(of: item == nil) { _, gone in if gone { dismiss() } }
        .confirmationDialog("Forget this?", isPresented: $confirmForget, titleVisibility: .visible) {
            Button("Forget", role: .destructive) {
                if let item { store.forget(world, item) }
                dismiss()
            }
        } message: {
            Text("It is deleted for good and no agent will remember it.")
        }
    }

    @ViewBuilder private func content(_ item: Contract.MemoryItemView, _ store: TeamMemoryStore) -> some View {
        let agent = world.agent(item.agentId)
        let selected = item.audience?.kind == "group" ? "keep" : (item.audience?.kind == "public" ? "public" : "owner")
        let options = [("owner", "Only you")]
            + (item.audience?.kind == "group" ? [("keep", item.audience?.label ?? "The group")] : [])
            + [("public", "Everyone")]
        JunoFormField(label: "Memory text") {
            TextField("", text: $draft, axis: .vertical)
                .lineLimit(3...8)
                .padding(.vertical, 12)
                .inputField()
                .accessibilityIdentifier("memory-fact-text")
        }
        let provenance = MemoryMeta.provenance(item)
        VStack(alignment: .leading, spacing: 6) {
            if let quote = MemoryMeta.quote(item) {
                Text("\u{201C}\(quote)\u{201D}").text(.md).foregroundStyle(Theme.fg).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("memory-fact-quote")
            }
            if !provenance.isEmpty {
                HStack(spacing: 8) {
                    if let agent { AvatarView(agent: agent, size: 20).accessibilityHidden(true) }
                    Text(provenance).text(.sm).foregroundStyle(Theme.fgSubtle)
                }
            }
        }
        JunoFormField(label: "Who can hear it") {
            Picker("Who can hear it", selection: Binding(get: { selected }, set: { choose($0, item, store) })) {
                ForEach(options, id: \.0) { Text($0.1).tag($0.0) }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("memory-fact-audience")
        }
        VStack(alignment: .leading, spacing: 6) {
            Toggle("Keep private", isOn: Binding(get: { item.sensitive == true }, set: { store.setSensitive(world, item, $0) }))
                .accessibilityIdentifier("memory-fact-private")
            Text("Only used in your private chats, never in groups.").text(.xs).foregroundStyle(Theme.fgSubtle)
        }
        if store.refused { JunoMessage(text: "That change was not saved, so it is back as it was.") }
        Button { confirmForget = true } label: { Text("Forget").foregroundStyle(Theme.danger).frame(maxWidth: .infinity) }
            .buttonStyle(WebButton(variant: .secondary, size: .large))
            .accessibilityIdentifier("memory-fact-forget")
    }

    /// The edited text, when it differs from the item's.
    private func textChange(_ item: Contract.MemoryItemView) -> String? {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed != item.text ? trimmed : nil
    }

    /// The group stays "keep"; choosing Only you or Everyone sends that audience.
    private func choose(_ value: String, _ item: Contract.MemoryItemView, _ store: TeamMemoryStore) {
        guard value != "keep", value != item.audience?.kind else { return }
        store.edit(world, item, text: nil, audience: value, sensitive: nil)
    }
}

// MARK: - Search

/// Search (the bar's magnifier): the items whose text contains what was typed, as plain lines; a tap opens the item's sheet.
struct MemorySearchPage: View {
    @Environment(World.self) private var world
    @State private var query = ""
    @State private var limit = 20
    @State private var fact: FactPick?

    var body: some View {
        let store = world.teamMemory
        let found = query.isEmpty ? [] : store.items.filter { ($0.text ?? "").localizedCaseInsensitiveContains(query) }
        List {
            TeamSearchField(text: $query, prompt: "Search memory", autofocus: true).teamRow(separator: false)
            if !query.isEmpty && found.isEmpty {
                Text("Nothing matches.").text(.sm).foregroundStyle(Theme.fgMuted).teamRow(separator: false)
            }
            ForEach(found.prefix(limit), id: \.id) { item in
                Button { fact = FactPick(id: item.id) } label: { MemoryRow(item: item) }
                    .buttonStyle(.plain)
                    .teamRow(vertical: 10)
            }
            if found.count > limit {
                ShowMoreButton(title: "Show more") { limit += 20 }.teamRow(separator: false)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.canvas)
        .pageHeader("Search memory")
        .memoryFactSheet($fact)
    }
}

/// One remembered item as a line: its text, a lock when sensitive, the group's name when it was said in a group, and the small
/// avatar of the agent that wrote it. No controls.
private struct MemoryRow: View {
    @Environment(World.self) private var world
    var item: Contract.MemoryItemView

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text(item.text ?? "").text(.md).foregroundStyle(Theme.fg).lineLimit(2).multilineTextAlignment(.leading)
                let group = MemoryMeta.group(item)
                if item.sensitive == true || group != nil {
                    HStack(spacing: 6) {
                        if item.sensitive == true {
                            Image(systemName: "lock.fill").text(.xxs).foregroundStyle(Theme.fgSubtle).accessibilityLabel("Sensitive")
                        }
                        if let group {
                            Text(group).text(.xs).foregroundStyle(Theme.fgMuted).lineLimit(1)
                        }
                    }
                }
            }
            Spacer(minLength: 0)
            if let agent = world.agent(item.agentId) {
                AvatarView(agent: agent, size: AvatarSize.xs).accessibilityHidden(true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
        .accessibilityIdentifier("memory-row-\(item.id)")
    }
}

// MARK: - Review queue

/// Items waiting for the owner: Keep leaves the item in memory, Delete (after a confirm) removes it.
struct MemoryReviewPage: View {
    @Environment(World.self) private var world
    @State private var deleting: Contract.MemoryItemView?

    var body: some View {
        let store = world.teamMemory
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                if store.review.isEmpty {
                    Text("Nothing to review.").text(.sm).foregroundStyle(Theme.fgMuted)
                }
                if store.refused {
                    Text("That change was not saved, so it is back as it was.").text(.sm).foregroundStyle(Theme.warning)
                }
                ForEach(store.review, id: \.id) { item in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(item.text ?? "").text(.md).foregroundStyle(Theme.fg)
                        Text(MemoryMeta.line(item)).text(.xs).foregroundStyle(Theme.fgSubtle)
                        HStack(spacing: 12) {
                            Spacer(minLength: 0)
                            Button("Delete") { deleting = item }.buttonStyle(.plain).text(.sm).foregroundStyle(Theme.fgMuted)
                            Button("Keep") { store.resolveReview(world, item, action: "keep") }
                                .buttonStyle(WebButton(variant: .primary, size: .sm))
                        }
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.muted, in: .rect(cornerRadius: Radius.lg))
                }
            }
            .padding(16)
        }
        .background(Theme.canvas)
        .pageHeader("To review")
        .confirmationDialog("Delete this?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible, presenting: deleting) { item in
            Button("Delete", role: .destructive) { store.resolveReview(world, item, action: "delete") }
        } message: { _ in
            Text("It is deleted for good and no agent will remember it.")
        }
    }
}
