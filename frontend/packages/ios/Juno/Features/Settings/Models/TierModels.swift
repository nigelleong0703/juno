import SwiftUI

/// Settings → Models → "What each job runs on": four rows (chat, tasks, hard problems, quick jobs), each with its own
/// model and thinking level. A row shows what it runs on now (`effectiveTiers`) and opens a pushed editor. The server
/// replaces `models.tiers` whole, so every save sends all the rows the owner has set.
struct TierModelsSection: View {
    @Environment(World.self) private var world
    var providers: [ModelProvider]
    @State private var settings: ModelTiers?
    @State private var catalogs: [String: ProviderCatalog] = [:]
    @State private var unavailable = false

    private var eligible: [ModelProvider] { providers.filter { $0.hasKey && !$0.isSystemOne } }

    var body: some View {
        Section {
            ForEach(TierKey.allCases) { key in
                NavigationLink {
                    TierEditor(key: key, initial: settings?.chosen[key] ?? TierChoice(), effective: settings?.effective[key],
                               groups: groups, catalogs: catalogs) { choice in try await save(key, choice) }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(key.title).foregroundStyle(Theme.fg)
                        summary(key)
                        Text(key.blurb).text(.sm).foregroundStyle(Theme.fgMuted)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .disabled(settings == nil)
                .accessibilityIdentifier("tier-\(key.rawValue)")
            }
        } header: { Text("What each job runs on") } footer: {
            if unavailable { Text("Some providers' model lists aren't available right now.") }
        }
        .task(id: providers.map(\.id)) { await load() }
    }

    @ViewBuilder private func summary(_ key: TierKey) -> some View {
        if let settings {
            if let e = settings.effective[key] {
                // Only the model name truncates; the effort and the Default tag always stay visible.
                HStack(spacing: 0) {
                    Text(tierModelName(e, catalogs: catalogs)).lineLimit(1).truncationMode(.tail)
                    if let effort = e.effort { Text(" · \(effortLabel(effort))").lineLimit(1).fixedSize().layoutPriority(1) }
                    if e.source == "default" { Text("  Default").lineLimit(1).fixedSize().layoutPriority(1).foregroundStyle(Theme.fgSubtle) }
                }
                .text(.sm).foregroundStyle(Theme.fgMuted)
            } else {
                Text("Default").text(.sm).foregroundStyle(Theme.fgSubtle)
            }
        } else {
            Text("…").text(.sm).foregroundStyle(Theme.fgMuted)
        }
    }

    private var groups: [ModelChoicePicker.Group] {
        ([platformPickerProvider] + eligible).compactMap { provider in
            guard let items = catalogs[provider.id]?.items, !items.isEmpty else { return nil }
            return ModelChoicePicker.Group(provider: provider, items: items)
        }
    }

    private func load() async {
        settings = await world.modelTiers()
        var found: [String: ProviderCatalog] = [:]
        var failed = false
        await withTaskGroup(of: (String, ProviderCatalog?).self) { group in
            for p in eligible { group.addTask { (p.id, try? await world.providerCatalog(p.id)) } }
            if world.modelProviders?.platformDefault == true { group.addTask { (platformCatalogKey, try? await world.platformCatalog()) } }
            for await (id, catalog) in group { if let catalog { found[id] = catalog } else { failed = true } }
        }
        catalogs = found; unavailable = failed
    }

    private func save(_ key: TierKey, _ choice: TierChoice) async throws {
        var all = settings?.chosen ?? [:]
        all[key] = choice.isDefault ? nil : choice
        try await world.saveTiers(all)
        settings = await world.modelTiers() ?? settings
    }
}

/// The catalog key of the platform's own endpoint (`providerId` absent).
let platformCatalogKey = "__platform__"

/// The platform source in the model picker: a row is saved as `{ modelId }` without `providerId`.
let platformPickerProvider = ModelProvider(id: platformCatalogKey, name: "Juno", kind: "platform", hasKey: true)

func tierCatalogItem(_ catalogs: [String: ProviderCatalog], _ providerId: String?, _ modelId: String?) -> ProviderCatalog.Item? {
    catalogs[providerId ?? platformCatalogKey]?.items.first { $0.id == modelId }
}

func tierModelName(_ e: EffectiveTier, catalogs: [String: ProviderCatalog]) -> String {
    tierCatalogItem(catalogs, e.providerId, e.modelId)?.name ?? e.modelId
}

func effortLabel(_ effort: String) -> String { effort == "none" ? "No thinking" : effort.capitalized }

/// One row's model and thinking level. The thinking levels are the ones the chosen model's catalog lists; with no model
/// chosen they come from the model the row uses now (Quick jobs has none to go on, so it waits for a model).
private struct TierEditor: View {
    @Environment(\.dismiss) private var dismiss
    var key: TierKey
    var initial: TierChoice
    var effective: EffectiveTier?
    var groups: [ModelChoicePicker.Group]
    var catalogs: [String: ProviderCatalog]
    var save: (TierChoice) async throws -> Void
    @State private var draft = TierChoice()
    @State private var started = false
    @State private var saving = false
    @State private var error: String?

    private var selection: BackgroundChoice? {
        guard let m = draft.modelId else { return nil }
        return BackgroundChoice(providerId: draft.providerId ?? platformCatalogKey, modelId: m)
    }

    private var modelName: String {
        guard let m = draft.modelId else { return "Default" }
        return tierCatalogItem(catalogs, draft.providerId, m)?.name ?? m
    }

    private var efforts: [String] {
        if let m = draft.modelId { return tierCatalogItem(catalogs, draft.providerId, m)?.reasoningEfforts ?? [] }
        guard key != .fast, let e = effective else { return [] }
        return tierCatalogItem(catalogs, e.providerId, e.modelId)?.reasoningEfforts ?? []
    }

    private var effortEnabled: Bool { !efforts.isEmpty && (key != .fast || draft.modelId != nil) }
    private var dirty: Bool { draft != initial }

    var body: some View {
        List {
            Group {
                Section {
                    NavigationLink {
                        ModelChoicePicker(title: key.title, autoLabel: "Default", groups: groups, selection: selection) { pick in
                            draft.providerId = pick.flatMap { $0.providerId == platformCatalogKey ? nil : $0.providerId }
                            draft.modelId = pick?.modelId
                            if let effort = draft.effort, !efforts.contains(effort) { draft.effort = nil }
                            if key == .fast, draft.modelId == nil { draft.effort = nil }
                        }
                    } label: {
                        LabeledContent("Model", value: modelName)
                    }
                    .accessibilityIdentifier("tier-model")
                    Picker("Thinking", selection: Binding(get: { draft.effort ?? "" }, set: { draft.effort = $0.isEmpty ? nil : $0 })) {
                        Text("Default").tag("")
                        ForEach(efforts, id: \.self) { Text(effortLabel($0)).tag($0) }
                    }
                    .disabled(!effortEnabled)
                    .accessibilityIdentifier("tier-effort")
                } header: { Text(key.title) } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(key.blurb)
                        if key == .fast, draft.modelId == nil { Text("Choose a model to set its thinking level.") }
                        else if !effortEnabled, draft.modelId != nil { Text("This model has no thinking levels to choose.") }
                        if let error { Text(error).foregroundStyle(Theme.danger) }
                    }
                }
                Section {
                    Button(action: { Task { await commit(draft) } }) { if saving { ProgressView() } else { Text("Save") } }
                        .disabled(!dirty || saving)
                        .accessibilityIdentifier("tier-save")
                    if !initial.isDefault || !draft.isDefault {
                        Button("Reset to default", role: .destructive) { draft = TierChoice(); Task { await commit(TierChoice()) } }
                            .disabled(saving)
                            .accessibilityIdentifier("tier-reset")
                    }
                }
            }
            .listRowBackground(Theme.muted)
        }
        .webGrouped()
        .pageHeader(key.title)
        .onAppear { if !started { draft = initial; started = true } }
    }

    private func commit(_ choice: TierChoice) async {
        saving = true; error = nil
        defer { saving = false }
        do { try await save(choice); dismiss() } catch { self.error = providerErrorMessage(error) }
    }
}
