import SwiftUI

/// Settings → What's worth interrupting me for: what Juno has learned from the Ideas buttons and from chat, grouped by what it
/// does. Every rule can be removed; one that is due for review asks to be kept or removed.
struct ProactiveRulesView: View {
    @Environment(World.self) private var world
    @State private var rules: [ProactiveRule] = []
    @State private var loaded = false
    @State private var limits: [String: Int] = [:]
    @State private var removing: ProactiveRule?

    private static let groups: [(kind: String, title: String)] = [
        ("dont", "Don't tell me"), ("less", "Less of"), ("tell", "Tell me"), ("where", "Where and how"),
    ]

    var body: some View {
        List {
            if loaded && rules.isEmpty {
                Section {
                    Text("Juno learns from the buttons and from what you tell it in chat, e.g. \u{201C}stop telling me about cricket\u{201D}.")
                        .text(.base).foregroundStyle(Theme.fgMuted)
                }
                .listRowBackground(Theme.muted)
            }
            ForEach(Self.groups, id: \.kind) { group in
                let items = rules.filter { $0.kind == group.kind }
                if !items.isEmpty {
                    let limit = limits[group.kind] ?? 5
                    Section(group.title) {
                        ForEach(items.prefix(limit)) { rule in
                            row(rule)
                                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                    Button(role: .destructive) { removing = rule } label: { Label("Remove", systemImage: "trash") }
                                }
                        }
                        if items.count > limit {
                            Button("Show \(items.count - limit) more") { limits[group.kind] = limit + 5 }
                                .foregroundStyle(Theme.fgMuted)
                        }
                    }
                    .listRowBackground(Theme.muted)
                }
            }
        }
        .webGrouped()
        .pageHeader("What's worth interrupting me for")
        .task { await load() }
        .refreshable { await load() }
        .confirmationDialog("Remove this?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
            Button("Remove", role: .destructive) { if let rule = removing { remove(rule) } }
        } message: {
            Text(removing?.text ?? "")
        }
    }

    private func row(_ rule: ProactiveRule) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(rule.text).text(.base).foregroundStyle(Theme.fg)
                if rule.dueForReview { CategoryBadge(text: "Review") }
            }
            Text("\(rule.source) \u{00B7} \(Self.dateText(rule.date))").text(.sm).foregroundStyle(Theme.fgMuted)
            if rule.dueForReview {
                HStack(spacing: 12) {
                    Button("Keep") { keep(rule) }.buttonStyle(WebButton(variant: .secondary, size: .sm))
                    Button("Remove") { removing = rule }.buttonStyle(WebButton(variant: .ghost, size: .sm))
                }
                .padding(.top, 4)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("proactive-rule-\(rule.id)")
    }

    private func load() async {
        guard let api = world.api else { loaded = true; return }
        if let fresh = try? await api.list("/v1/proactive/rules", as: ProactiveRule.self) { rules = fresh }
        loaded = true
    }

    private func remove(_ rule: ProactiveRule) {
        withAnimation { rules.removeAll { $0.id == rule.id } }
        world.remote { try await $0.delete("/v1/proactive/rules/\(rule.id)") }
    }

    /// "Keep": the server pushes the review date out 90 days; the badge goes.
    private func keep(_ rule: ProactiveRule) {
        if let i = rules.firstIndex(where: { $0.id == rule.id }) { rules[i].dueForReview = false }
        struct Body: Encodable { var keep = true }
        world.remote { try await $0.patch("/v1/proactive/rules/\(rule.id)", Body()) }
    }

    private static func dateText(_ date: String) -> String {
        let parser = DateFormatter()
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.dateFormat = "yyyy-MM-dd"
        guard let parsed = parser.date(from: date) else { return date }
        return parsed.formatted(date: .abbreviated, time: .omitted)
    }
}
