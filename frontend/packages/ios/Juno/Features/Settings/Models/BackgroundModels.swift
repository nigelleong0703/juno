import SwiftUI

/// Settings → Models → the System One model, for quick safety judgments such as before an order. A pushed, searchable
/// list over the owner's System One providers plus "Auto"; Auto shows the model the server would use right now and why.
/// (The fast model is now the "Quick jobs" row of `TierModelsSection`.)
struct BackgroundModelsSection: View {
    @Environment(World.self) private var world
    var providers: [ModelProvider]
    @State private var models: BackgroundModels?
    @State private var catalogs: [String: ProviderCatalog] = [:]
    @State private var unavailable = false
    @State private var saving = false
    @State private var error: String?

    private var eligible: [ModelProvider] { providers.filter { $0.hasKey && $0.isSystemOne } }

    var body: some View {
        let choice = models?.systemOne
        Section {
            NavigationLink {
                ModelChoicePicker(title: "System One model", autoLabel: "Auto", groups: groups, selection: choice) { pick in save(pick) }
            } label: {
                LabeledContent("System One model", value: label)
            }
            .disabled(models == nil || saving)
            .accessibilityIdentifier("systemone-model")
            if eligible.isEmpty {
                Text("Add a System One provider to choose one.").text(.sm).foregroundStyle(Theme.fgMuted)
            }
        } header: { Text("Background models") } footer: {
            VStack(alignment: .leading, spacing: 4) {
                if choice == nil, let models { Text(autoLine(models.effectiveSystemOne)) }
                Text("Used for quick safety judgments, such as before your agent places an order.")
                if let error { Text(error).foregroundStyle(Theme.danger) }
                else if unavailable { Text("Some providers' model lists aren't available right now.") }
            }
        }
        .task(id: providers.map(\.id)) { await load() }
    }

    private var groups: [ModelChoicePicker.Group] {
        eligible.compactMap { provider in
            guard let items = catalogs[provider.id]?.items, !items.isEmpty else { return nil }
            return ModelChoicePicker.Group(provider: provider, items: items)
        }
    }

    private func name(of providerId: String?, _ modelId: String) -> String {
        providerId.flatMap { catalogs[$0]?.items.first { $0.id == modelId }?.name } ?? modelId
    }

    private var label: String {
        guard let models else { return "…" }
        guard let c = models.systemOne else { return "Auto" }
        return name(of: c.providerId, c.modelId)
    }

    private func autoLine(_ e: EffectiveModel?) -> String {
        guard let e else { return "Auto — no model available yet." }
        let model = name(of: e.providerId, e.modelId)
        return switch e.source {
        case "platform": "Auto — \(model), the service default."
        case "fast-model-emulation": "Auto — \(model), your quick-jobs model stands in."
        default: "Auto — \(model)."
        }
    }

    private func load() async {
        models = await world.backgroundModels()
        var found: [String: ProviderCatalog] = [:]
        var failed = false
        await withTaskGroup(of: (String, ProviderCatalog?).self) { group in
            for p in eligible { group.addTask { (p.id, try? await world.providerCatalog(p.id)) } }
            for await (id, catalog) in group { if let catalog { found[id] = catalog } else { failed = true } }
        }
        catalogs = found; unavailable = failed
    }

    private func save(_ pick: BackgroundChoice?) {
        saving = true; error = nil
        Task { @MainActor in
            defer { saving = false }
            do { try await world.saveSystemOneModel(pick) } catch { self.error = providerErrorMessage(error) }
            models = await world.backgroundModels() ?? models
        }
    }
}

/// The "default" row first (`autoLabel`), then each provider's models under its name (searchable; a long catalog shows a
/// few, then "Show N more").
struct ModelChoicePicker: View {
    struct Group: Identifiable { var provider: ModelProvider; var items: [ProviderCatalog.Item]; var id: String { provider.id } }

    @Environment(\.dismiss) private var dismiss
    var title: String
    var autoLabel: String
    var groups: [Group]
    var selection: BackgroundChoice?
    var onPick: (BackgroundChoice?) -> Void
    @State private var query = ""
    @State private var expanded: Set<String> = []

    private static let cap = 8
    private var searching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

    private func items(_ group: Group) -> [ProviderCatalog.Item] {
        let all = searching ? group.items.filter { $0.name.localizedCaseInsensitiveContains(query) || $0.id.localizedCaseInsensitiveContains(query) } : group.items
        // Recommended models first, so they stay visible under the cap.
        return all.sorted { ($0.cheap ?? false) && !($1.cheap ?? false) }
    }

    var body: some View {
        List {
            SwiftUI.Group {
                if !searching {
                    Section { row(autoLabel, subtitle: nil, selected: selection == nil) { pick(nil) }.accessibilityIdentifier("background-auto") }
                }
                ForEach(groups) { group in
                    let all = items(group)
                    let shown = searching || expanded.contains(group.id) ? all : Array(all.prefix(Self.cap))
                    if !all.isEmpty {
                        Section(group.provider.name) {
                            ForEach(shown) { item in
                                row(item.name, subtitle: item.cheap == true ? "Recommended" : nil,
                                    selected: selection == BackgroundChoice(providerId: group.provider.id, modelId: item.id)) {
                                    pick(BackgroundChoice(providerId: group.provider.id, modelId: item.id))
                                }
                            }
                            if !searching, all.count > Self.cap {
                                Button(expanded.contains(group.id) ? "Show fewer" : "Show \(all.count - Self.cap) more") {
                                    withAnimation { if expanded.contains(group.id) { expanded.remove(group.id) } else { expanded.insert(group.id) } }
                                }
                            }
                        }
                    }
                }
                if searching, groups.allSatisfy({ items($0).isEmpty }) { Text("No model matches that.").foregroundStyle(Theme.fgMuted) }
            }
            .listRowBackground(Theme.muted)
        }
        .webGrouped()
        .searchable(text: $query, prompt: "Search models")
        .pageHeader(title)
    }

    private func pick(_ choice: BackgroundChoice?) { onPick(choice); dismiss() }

    private func row(_ title: String, subtitle: String?, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).foregroundStyle(Theme.fg)
                    if let subtitle { Text(subtitle).text(.sm).foregroundStyle(Theme.fgMuted) }
                }
                Spacer()
                if selected { Image(systemName: "checkmark").foregroundStyle(Theme.fg) }
            }
        }
    }
}
