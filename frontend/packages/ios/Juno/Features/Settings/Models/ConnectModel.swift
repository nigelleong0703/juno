import SwiftUI

/// First-run gate, shown instead of the app while the account has no usable model (agents only run on the owner's own
/// provider). Not dismissable: first connect a provider, then choose its model. It goes away when a model is chosen
/// (RootView then opens the agent's chat).
struct ConnectModelView: View {
    @Environment(World.self) private var world
    @State private var addingKey = false
    @State private var signingIn = false

    private var agent: Agent? {
        let id = world.defaultDirectChat?.agentIds?.first
        return world.agents.first { $0.id == id }
    }

    private var keyed: [ModelProvider] {
        (world.modelProviders?.providers ?? []).filter { $0.hasKey && !$0.isSystemOne }
    }

    var body: some View {
        if keyed.isEmpty { connect } else { ChooseModelStep(providers: keyed, agent: agent) }
    }

    private var connect: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            VStack(spacing: 12) {
                if let agent { AvatarView(agent: agent, size: AvatarSize.card) }
                Text("Connect a model so \(agent?.name ?? "your agent") can start")
                    .text(.xl, .semibold).multilineTextAlignment(.center).foregroundStyle(Theme.fg)
                Text("Juno runs on your own AI account. You can change it later in Settings.")
                    .text(.base).multilineTextAlignment(.center).foregroundStyle(Theme.fgMuted)
            }
            .frame(maxWidth: 320)
            Spacer(minLength: 0)
            VStack(spacing: 12) {
                Button { signingIn = true } label: {
                    Text("Continue with ChatGPT").text(.md, .semibold).foregroundStyle(Theme.primaryFg).frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent).accessibilityIdentifier("connect-chatgpt")
                Button { addingKey = true } label: {
                    Text("Use an API key").text(.md, .semibold).frame(maxWidth: .infinity)
                }
                .buttonStyle(.glass).accessibilityIdentifier("connect-api-key")
                Button("Log out") { world.signOut() }
                    .text(.sm).foregroundStyle(Theme.fgMuted).padding(.top, 8)
                    .accessibilityIdentifier("connect-logout")
            }
            .controlSize(.large)
            .padding(.horizontal, 24).padding(.bottom, 8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.canvas.ignoresSafeArea())
        .task { await world.refreshModelProviders() }
        .sheet(isPresented: $addingKey) {
            AddProviderSheet(onAdded: refresh, firstRun: true).junoSheetPresentation(long: true)
        }
        .sheet(isPresented: $signingIn) {
            NavigationStack {
                ChatGPTSignInView { refresh(); signingIn = false }
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { signingIn = false } } }
            }
            .tint(Theme.fg)
            .junoSheetPresentation(long: true)
        }
    }

    private func refresh() { Task { await world.refreshModelProviders() } }
}

/// Step two: a provider is connected; choose the model agents run on. Saving it makes the account usable.
private struct ChooseModelStep: View {
    @Environment(World.self) private var world
    var providers: [ModelProvider]
    var agent: Agent?
    @State private var providerId = ""
    @State private var catalog: ProviderCatalog?
    @State private var catalogError: String?
    @State private var picked: String?
    @State private var saving = false
    @State private var saveError: String?
    @State private var showingAll = false

    private static let shown = 5

    private var items: [ProviderCatalog.Item] { catalog?.items ?? [] }
    /// Nothing is preselected: the owner picks the model.
    private var modelId: String { picked ?? "" }
    /// The catalog's first few; a pick from the full list stays visible at the top.
    private var rows: [ProviderCatalog.Item] {
        let head = picked.map { [$0] } ?? []
        let first = head.compactMap { id in items.first { $0.id == id } }
        return Array((first + items.filter { !head.contains($0.id) }).prefix(Self.shown))
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 12) {
                    if let agent { AvatarView(agent: agent, size: AvatarSize.card) }
                    Text("Pick the model \(agent?.name ?? "your agent") runs on")
                        .text(.xl, .semibold).multilineTextAlignment(.center).foregroundStyle(Theme.fg)
                    Text("You can change it later in Settings.")
                        .text(.base).multilineTextAlignment(.center).foregroundStyle(Theme.fgMuted)
                    if providers.count > 1 {
                        Picker("Provider", selection: Binding(get: { providerId }, set: pick)) {
                            ForEach(providers) { Text($0.name).tag($0.id) }
                        }
                        .pickerStyle(.menu).accessibilityIdentifier("gate-provider")
                    }
                    list
                }
                .frame(maxWidth: 360).padding(.horizontal, 24).padding(.top, 48)
                .frame(maxWidth: .infinity)
            }
            VStack(spacing: 12) {
                if let saveError { Text(saveError).text(.sm).foregroundStyle(Theme.danger).multilineTextAlignment(.center) }
                Button(action: save) {
                    Group { if saving { ProgressView() } else { Text("Continue") } }
                        .text(.md, .semibold).foregroundStyle(Theme.primaryFg).frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent).disabled(modelId.isEmpty || saving)
                .accessibilityIdentifier("gate-continue")
                Button("Log out") { world.signOut() }
                    .text(.sm).foregroundStyle(Theme.fgMuted).padding(.top, 8)
            }
            .controlSize(.large)
            .padding(.horizontal, 24).padding(.bottom, 8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.canvas.ignoresSafeArea())
        .task {
            if !providers.contains(where: { $0.id == providerId }) { providerId = providers[0].id }
            await loadCatalog()
        }
        .sheet(isPresented: $showingAll) {
            NavigationStack {
                ModelPickerList(items: items, selection: Binding(get: { modelId }, set: { picked = $0 }))
            }
            .tint(Theme.fg)
            .junoSheetPresentation(long: true)
        }
    }

    @ViewBuilder private var list: some View {
        if let catalog {
            VStack(spacing: 0) {
                ForEach(rows) { item in
                    Button { picked = item.id } label: {
                        HStack(spacing: 8) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.name).foregroundStyle(Theme.fg)
                                if item.supportsImages == true { Text("Accepts images").text(.sm).foregroundStyle(Theme.fgMuted) }
                            }
                            Spacer()
                            if item.id == modelId { Image(systemName: "checkmark").foregroundStyle(Theme.fg) }
                        }
                        .padding(.horizontal, 14).padding(.vertical, 12)
                        .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if item.id != rows.last?.id { Divider().padding(.leading, 14) }
                }
                if catalog.items.count > rows.count {
                    Divider().padding(.leading, 14)
                    Button { showingAll = true } label: {
                        HStack {
                            Text("Show all models").foregroundStyle(Theme.fgMuted)
                            Spacer()
                            Image(systemName: "chevron.right").text(.sm).foregroundStyle(Theme.fgSubtle)
                        }
                        .padding(.horizontal, 14).padding(.vertical, 12).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).accessibilityIdentifier("gate-show-all")
                }
            }
            .background(Theme.muted, in: RoundedRectangle(cornerRadius: 12))
            .padding(.top, 8)
        } else if let catalogError {
            VStack(spacing: 8) {
                Text(catalogError).text(.sm).foregroundStyle(Theme.fgMuted).multilineTextAlignment(.center)
                Button("Retry") { Task { await loadCatalog() } }
            }
            .padding(.top, 16)
        } else {
            ProgressView().padding(.top, 24)
        }
    }

    private func pick(_ id: String) {
        guard id != providerId else { return }
        providerId = id
        catalog = nil; catalogError = nil; picked = nil; saveError = nil
        Task { await loadCatalog() }
    }

    private func loadCatalog() async {
        if providerId.isEmpty { providerId = providers[0].id }
        let id = providerId
        catalogError = nil
        do {
            let result = try await world.providerCatalog(id)
            guard id == providerId else { return }
            catalog = result
        } catch {
            guard id == providerId else { return }
            if case APIError.api(_, "MODEL_CATALOG_UNAVAILABLE", _) = error { catalogError = "This provider's model list isn't available right now." }
            else { catalogError = "Couldn't load models." }
        }
    }

    private func save() {
        saving = true; saveError = nil
        Task { @MainActor in
            defer { saving = false }
            do {
                try await world.saveModelChoice(ModelChoice(providerId: providerId, model: modelId))
                await world.refreshModelProviders()
            } catch {
                saveError = providerErrorMessage(error)
            }
        }
    }
}
