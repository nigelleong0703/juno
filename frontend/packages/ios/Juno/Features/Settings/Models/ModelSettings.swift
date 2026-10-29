import SwiftUI

/// Settings → Models: the owner's providers (own API key or ChatGPT subscription) and the default model.
/// Native List/Form; content follows the web's Settings → Models (docs/design/VISUAL.md "Model providers (BYOK)").
struct ModelSettingsView: View {
    @Environment(World.self) private var world
    @State private var showAll = false
    @State private var adding = false
    @State private var replacing: ModelProvider?
    @State private var renaming: ModelProvider?
    @State private var renameText = ""
    @State private var signingIn: ModelProvider?
    @State private var removing: ModelProvider?
    @State private var error: String?
    @State private var defaultsRevision = 0

    private static let cap = 5
    private var list: ModelProviderList? { world.modelProviders }
    private var providers: [ModelProvider] { list?.providers ?? [] }

    var body: some View {
        List {
            Group {
                if let error { Section { Text(error).foregroundStyle(Theme.danger) } }
                if let list {
                    if providers.isEmpty {
                        Section {
                            ContentUnavailableView {
                                Label("Your agents need a model provider", systemImage: "key")
                            } description: {
                                Text(list.platformDefault
                                     ? "Agents use the service's default model. Add your own API key or ChatGPT subscription to use that instead."
                                     : "Agents reply using a model from your own provider: add an API key, or sign in with your ChatGPT subscription.")
                            } actions: {
                                Button("Add provider") { adding = true }.buttonStyle(WebButton(variant: .primary, size: .regular))
                                    .accessibilityIdentifier("models-empty-add")
                            }
                            .listRowBackground(Color.clear)
                        }
                    } else {
                        Section {
                            ForEach(showAll ? providers : Array(providers.prefix(Self.cap))) { row($0) }
                            if providers.count > Self.cap {
                                Button(showAll ? "Show fewer" : "Show \(providers.count - Self.cap) more") { withAnimation { showAll.toggle() } }
                            }
                        } header: { Text("Your providers") } footer: {
                            Text("Your agents talk to models through your own API key or ChatGPT subscription.")
                        }
                        Section { Button("Add provider", systemImage: "plus") { adding = true }.accessibilityIdentifier("models-add") }
                    }
                    DefaultModelSection(providers: providers, platformDefault: list.platformDefault)
                        .id(defaultsRevision)
                    WebSearchSection()
                    TierModelsSection(providers: providers)
                    BackgroundModelsSection(providers: providers)
                } else {
                    HStack { Spacer(); ProgressView(); Spacer() }
                }
            }
            .listRowBackground(Theme.muted)
        }
        .webGrouped()
        .pageHeader("Models")
        .task { await world.refreshModelProviders() }
        .refreshable { await world.refreshModelProviders() }
        .sheet(isPresented: $adding) { AddProviderSheet { Task { await world.refreshModelProviders(); defaultsRevision += 1 } }.junoSheetPresentation(long: true) }
        .sheet(item: $replacing) { provider in ReplaceKeySheet(provider: provider) { Task { await world.refreshModelProviders() } } }
        .sheet(item: $signingIn) { provider in
            NavigationStack {
                ChatGPTSignInView { Task { await world.refreshModelProviders(); defaultsRevision += 1 }; signingIn = nil }
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { signingIn = nil } } }
            }
            .tint(Theme.fg)
            .id(provider.id)
            .junoSheetPresentation(long: true)
        }
        .alert("Rename provider", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $renameText)
            Button("Cancel", role: .cancel) {}
            Button("Save") { if let p = renaming { rename(p) } }
        }
        .confirmationDialog(removing.map { "Remove \($0.name)?" } ?? "", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
            Button("Remove provider", role: .destructive) { if let p = removing { remove(p) } }
        } message: {
            Text("Your agents stop using this provider and its saved key is deleted. If it is your default model's provider, the default is cleared and you will need to choose a new one.")
        }
    }

    // MARK: Rows

    private func row(_ provider: ModelProvider) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(provider.name).foregroundStyle(Theme.fg)
            Text(typeLine(provider)).text(.sm).foregroundStyle(Theme.fgMuted)
            statusLine(provider)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("provider-\(provider.name)")
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button("Remove", role: .destructive) { removing = provider }
            Button("Rename") { renameText = provider.name; renaming = provider }.tint(Theme.fgSubtle)
            if provider.isChatGPT { Button("Sign in again") { signingIn = provider }.tint(Theme.fgMuted) }
            else { Button("Replace key") { replacing = provider }.tint(Theme.fgMuted) }
        }
        .contextMenu {
            if provider.isChatGPT { Button("Sign in again", systemImage: "arrow.clockwise") { signingIn = provider } }
            else { Button("Replace key", systemImage: "key") { replacing = provider } }
            Button("Rename", systemImage: "pencil") { renameText = provider.name; renaming = provider }
            Button("Remove", systemImage: "trash", role: .destructive) { removing = provider }
        }
    }

    private func typeLine(_ p: ModelProvider) -> String {
        if p.isChatGPT { return "ChatGPT subscription" }
        if p.isSystemOne {
            let host = p.baseUrl.flatMap { URL(string: $0)?.host } ?? p.baseUrl ?? ""
            return "System One · \(host) · \(p.models?.count ?? 0) models"
        }
        if p.kind == "custom" {
            let host = p.baseUrl.flatMap { URL(string: $0)?.host } ?? p.baseUrl ?? ""
            return "Custom · OpenAI-compatible · \(host)"
        }
        return "API key"
    }

    @ViewBuilder private func statusLine(_ p: ModelProvider) -> some View {
        if p.needsReauth {
            Label("Sign-in expired — sign in again", systemImage: "exclamationmark.triangle").text(.sm).foregroundStyle(Theme.warning)
        } else if p.isChatGPT {
            HStack(spacing: 6) {
                Label("Connected", systemImage: "checkmark.circle").foregroundStyle(Theme.success)
                if let at = p.accessExpiresAt { Text("Access expires \(Fmt.ago(at))").foregroundStyle(Theme.fgSubtle) }
            }
            .text(.sm)
        } else {
            Label(p.hasKey ? "Key saved" : "No key", systemImage: p.hasKey ? "checkmark.circle" : "xmark.circle")
                .text(.sm).foregroundStyle(p.hasKey ? Theme.success : Theme.warning)
        }
    }

    // MARK: Actions

    private func rename(_ provider: ModelProvider) {
        let name = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        Task { @MainActor in
            do { try await world.renameModelProvider(provider.id, to: name); error = nil }
            catch { self.error = providerErrorMessage(error) }
        }
    }

    private func remove(_ provider: ModelProvider) {
        Task { @MainActor in
            do { try await world.removeModelProvider(provider.id); error = nil }
            catch { self.error = providerErrorMessage(error) }
            defaultsRevision += 1
        }
    }
}

// MARK: - Replace key / rename

private struct ReplaceKeySheet: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var provider: ModelProvider
    var onDone: () -> Void
    @State private var key = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        JunoSheet(icon: "key", title: "Replace key for \(provider.name)", guidance: "The new key replaces the saved one. The old key is never shown.",
                  primary: "Save", primaryEnabled: !key.trimmingCharacters(in: .whitespaces).isEmpty, loading: busy, id: "replace-key",
                  onPrimary: save, onCancel: { dismiss() }) {
            JunoFormField(label: "API key", error: error) {
                SecureField("API key", text: $key).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityIdentifier("replace-key-field").inputField()
            }
        }
    }

    private func save() {
        busy = true; error = nil
        Task { @MainActor in
            do {
                try await world.replaceModelProviderKey(provider.id, apiKey: key.trimmingCharacters(in: .whitespacesAndNewlines))
                key = ""
                onDone(); dismiss()
            } catch { self.error = providerErrorMessage(error); busy = false }
        }
    }
}

// MARK: - Add provider

private enum AddStep: Hashable { case builtin(BuiltinProvider), custom, systemOne, chatgpt }

/// Custom endpoint first, then the popular built-ins; every other provider sits behind "Show all" or the search.
struct AddProviderSheet: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var onAdded: () -> Void
    /// The first-run gate: popular providers first; the custom endpoint rows wait behind "Show all".
    var firstRun = false
    @State private var builtins: [BuiltinProvider] = []
    @State private var loaded = false
    @State private var query = ""
    @State private var showAll = false
    @State private var path: [AddStep] = []

    private static let popular = ["openai", "anthropic", "openrouter", "google", "deepseek", "opencode-go"]

    private var searching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }
    private var matches: [BuiltinProvider] { builtins.filter { $0.name.localizedCaseInsensitiveContains(query) || $0.id.localizedCaseInsensitiveContains(query) } }
    private var popularRows: [BuiltinProvider] { Self.popular.compactMap { id in builtins.first { $0.id == id } } }
    private var others: [BuiltinProvider] { builtins.filter { !Self.popular.contains($0.id) } }
    private var showCustom: Bool { !searching || "custom openai-compatible endpoint".contains(query.lowercased()) }
    private var showSystemOne: Bool { !searching || "system one endpoint".contains(query.lowercased()) }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Group {
                    if searching {
                        if showCustom || showSystemOne { Section { if showCustom { customRow }; if showSystemOne { systemOneRow } } }
                        Section {
                            ForEach(matches) { builtinRow($0) }
                            if matches.isEmpty && !showCustom && !showSystemOne { Text("No provider matches that.").foregroundStyle(Theme.fgMuted) }
                        }
                    } else {
                        if !firstRun || showAll {
                            Section { customRow; systemOneRow } footer: {
                                Text("Custom: any service that speaks the OpenAI API (LiteLLM, vLLM, a gateway). System One: a typed-decision model such as TypeSafe Jev, for quick safety judgments.")
                            }
                        }
                        if !loaded { HStack { Spacer(); ProgressView(); Spacer() } }
                        Section("Popular") { ForEach(popularRows) { builtinRow($0) } }
                        if !others.isEmpty {
                            Section("All providers") {
                                if showAll { ForEach(others) { builtinRow($0) } }
                                else { Button("Show all \(builtins.count) providers") { withAnimation { showAll = true } } }
                            }
                        }
                    }
                }
                .listRowBackground(Theme.muted)
            }
            .webGrouped()
            .pageHeader("Add a model provider")
            .searchable(text: $query, prompt: "Search providers")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .navigationDestination(for: AddStep.self) { step in
                switch step {
                case .builtin(let p): ProviderKeyForm(builtin: p, onChatGPT: { path.append(.chatgpt) }, onAdded: added)
                case .custom: ProviderKeyForm(builtin: nil, onChatGPT: {}, onAdded: added)
                case .systemOne: ProviderKeyForm(builtin: nil, systemOne: true, onChatGPT: {}, onAdded: added)
                case .chatgpt: ChatGPTSignInView(onDone: added)
                }
            }
            .task {
                if let items = try? await world.builtinProviders() { builtins = items }
                loaded = true
            }
        }
        .tint(Theme.fg)
    }


    private func added() { onAdded(); dismiss() }

    private var customRow: some View { addRow("Custom OpenAI-compatible endpoint", icon: "server.rack", step: .custom, id: "add-custom") }
    private var systemOneRow: some View { addRow("System One endpoint", icon: "checkmark.shield", step: .systemOne, id: "add-systemone") }

    private func addRow(_ title: String, icon: String, step: AddStep, id: String) -> some View {
        Button { path.append(step) } label: {
            HStack {
                Label(title, systemImage: icon)
                Spacer()
                Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.fgSubtle)
            }
        }
        .foregroundStyle(Theme.fg)
        .accessibilityIdentifier(id)
    }

    private func builtinRow(_ p: BuiltinProvider) -> some View {
        Button { path.append(.builtin(p)) } label: {
            HStack {
                Text(p.name)
                Spacer()
                Text("\(p.modelCount) models").text(.sm).foregroundStyle(Theme.fgMuted)
                Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.fgSubtle)
            }
        }
        .foregroundStyle(Theme.fg)
        .accessibilityIdentifier("add-\(p.id)")
    }
}

/// The key step for a built-in provider, or the whole custom-endpoint form when `builtin` is nil.
private struct ProviderKeyForm: View {
    @Environment(World.self) private var world
    var builtin: BuiltinProvider?
    var systemOne = false
    var onChatGPT: () -> Void
    var onAdded: () -> Void
    @State private var name = ""
    @State private var modelIds = ""
    @State private var baseUrl = ""
    @State private var wire = "openai-completions"
    @State private var key = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focus: Field?
    private enum Field { case name, url, models, key }

    private var urlValid: Bool {
        guard let url = URL(string: baseUrl.trimmingCharacters(in: .whitespaces)), let scheme = url.scheme?.lowercased() else { return false }
        return ["http", "https"].contains(scheme) && url.host?.isEmpty == false
    }
    private var canSave: Bool {
        let hasKey = !key.trimmingCharacters(in: .whitespaces).isEmpty
        if builtin != nil { return hasKey }
        return hasKey && !name.trimmingCharacters(in: .whitespaces).isEmpty && urlValid && (!systemOne || !parsedModels.isEmpty)
    }
    /// The comma-separated ids, at most 20 (the server's limit).
    private var parsedModels: [String] {
        let ids = modelIds.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return ids.count <= 20 ? ids : []
    }

    var body: some View {
        Form {
            Group {
                if builtin == nil {
                    Section {
                        TextField("Name", text: $name).focused($focus, equals: .name).submitLabel(.next).onSubmit { focus = .url }
                            .foregroundStyle(Theme.fg).accessibilityIdentifier("custom-name")
                        TextField(systemOne ? "https://api.typesafe.ai" : "Base URL", text: $baseUrl)
                            .keyboardType(.URL).textContentType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                            .focused($focus, equals: .url).submitLabel(.next).onSubmit { focus = .key }
                            .foregroundStyle(Theme.fg).accessibilityIdentifier("custom-url")
                    } footer: {
                        if !baseUrl.isEmpty && !urlValid { Text("Enter a full address, like https://api.example.com/v1.").foregroundStyle(Theme.danger) }
                        else if !systemOne { Text("The URL ending in /v1, without /chat/completions.") }
                    }
                    if systemOne {
                        Section {
                            TextField("jev-latest", text: $modelIds)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                                .focused($focus, equals: .models).submitLabel(.next).onSubmit { focus = .key }
                                .foregroundStyle(Theme.fg).accessibilityIdentifier("systemone-models")
                        } header: { Text("Model ids") } footer: { Text("Comma-separated, up to 20. For example jev-latest.") }
                    } else {
                        Section("Protocol") {
                            Picker("Protocol", selection: $wire) {
                                Text("Chat Completions").tag("openai-completions")
                                Text("Responses").tag("openai-responses")
                            }
                            .pickerStyle(.segmented).labelsHidden()
                        }
                    }
                }
                Section {
                    SecureField("API key", text: $key)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .focused($focus, equals: .key).submitLabel(.done)
                        .foregroundStyle(Theme.fg).accessibilityIdentifier("provider-key-field")
                } footer: {
                    if let error { Text(error).foregroundStyle(Theme.danger).accessibilityIdentifier("provider-form-error") }
                    else { Text("Stored encrypted and never shown again. You can replace it later.") }
                }
                if builtin?.id == "openai" {
                    Section {
                        Button("Sign in with ChatGPT instead", action: onChatGPT).accessibilityIdentifier("use-chatgpt")
                    } footer: { Text("Have a ChatGPT Plus or Pro plan? Use it instead of an API key.") }
                }
            }
            .listRowBackground(Theme.muted)
        }
        .webGrouped()
        .pageHeader(builtin.map { "Connect \($0.name)" } ?? (systemOne ? "System One provider" : "Custom endpoint"))
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if busy { ProgressView() } else {
                    Button("Add provider", action: save).disabled(!canSave).accessibilityIdentifier("provider-save")
                }
            }
        }
        .disabled(busy)
    }

    private func save() {
        busy = true; error = nil
        Task { @MainActor in
            do {
                try await world.addModelProvider(builtin: builtin, name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                                                 baseUrl: baseUrl.trimmingCharacters(in: .whitespaces), wire: wire,
                                                 apiKey: key.trimmingCharacters(in: .whitespacesAndNewlines),
                                                 systemOneModels: systemOne ? parsedModels : nil)
                key = ""
                onAdded()
            } catch { self.error = providerErrorMessage(error); busy = false }
        }
    }
}

// MARK: - ChatGPT sign-in

/// The subscription sign-in has no redirect the app can catch: the browser ends on http://127.0.0.1:1455, which can't load.
/// ASWebAuthenticationSession only matches a custom scheme or an https host, so the person opens the link in Safari and
/// pastes the final address back. A login is spent by its first attempt, so a failed one starts a fresh login.
struct ChatGPTSignInView: View {
    @Environment(World.self) private var world
    @Environment(\.openURL) private var openURL
    var onDone: () -> Void
    @State private var login: ChatGPTLogin?
    @State private var address = ""
    @State private var busy = false
    @State private var starting = false
    @State private var notice: String?
    @State private var opened = false

    var body: some View {
        Form {
            Group {
                Section {
                    Button(opened ? "Open sign-in page again" : "Open ChatGPT sign-in") {
                        if let login, let url = URL(string: login.authorizationUrl) { openURL(url); opened = true }
                    }
                    .disabled(login == nil)
                    .accessibilityIdentifier("chatgpt-open")
                } header: { Text("Step 1") } footer: {
                    Text("Open the ChatGPT sign-in page and sign in with the account that has your subscription. This sign-in link is valid for 10 minutes.")
                }
                Section {
                    TextField("http://127.0.0.1:1455/auth/callback?code=…", text: $address, axis: .vertical)
                        .lineLimit(1...4)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .foregroundStyle(Theme.fg).accessibilityIdentifier("chatgpt-address")
                    PasteButton(payloadType: String.self) { strings in address = strings.first ?? "" }
                        .accessibilityIdentifier("chatgpt-paste")
                } header: { Text("Step 2") } footer: {
                    if let notice { Text(notice).foregroundStyle(Theme.warning) }
                    else {
                        Text("After you sign in, your browser goes to a page that won't load (127.0.0.1:1455). That's expected. Copy the full address from the address bar and paste it here.")
                    }
                }
                Section {
                    Button { connect() } label: {
                        if busy { ProgressView() } else { Text("Connect") }
                    }
                    .disabled(login == nil || address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
                    .accessibilityIdentifier("chatgpt-connect")
                }
            }
            .listRowBackground(Theme.muted)
        }
        .webGrouped()
        .pageHeader("Sign in with ChatGPT")
        .task { if login == nil { await start() } }
    }

    private func start() async {
        guard !starting else { return }
        starting = true; defer { starting = false }
        do {
            login = try await world.startChatGPTLogin()
            opened = false
        } catch { notice = "Couldn't start the sign-in. Try again." }
    }

    private func connect() {
        guard let login else { return }
        busy = true; notice = nil
        let callback = address.trimmingCharacters(in: .whitespacesAndNewlines)
        Task { @MainActor in
            defer { busy = false }
            do {
                try await world.completeChatGPTLogin(loginId: login.loginId, callbackUrl: callback)
                address = ""
                onDone()
            } catch {
                if let reason = chatGPTLoginFailure(error) {
                    address = ""
                    self.login = nil
                    await start()
                    notice = "That didn't work: \(reason) We made a new sign-in link. Open it, sign in, then paste the new address."
                } else { notice = "Couldn't connect. Check the address and try again." }
            }
        }
    }
}

private extension Data {
    func decoded<T: Decodable>(_ type: T.Type) throws -> T { try isoDecoder.decode(T.self, from: self) }
}

// MARK: - Web search

/// Settings → Models → Web search: use the model's own search when it has one (Auto) or always Juno's.
private struct WebSearchSection: View {
    @Environment(World.self) private var world
    @State private var mode: String?
    @State private var error: String?

    var body: some View {
        Section {
            Picker("Web search", selection: Binding(get: { mode ?? "auto" }, set: save)) {
                Text("Auto").tag("auto")
                Text("Juno").tag("juno")
            }
            .disabled(mode == nil)
            .accessibilityIdentifier("web-search")
        } header: { Text("Web search") } footer: {
            if let error { Text(error).foregroundStyle(Theme.danger) }
            else { Text(mode == "juno" ? "Agents always search with Juno's own search, whichever model they use."
                                       : "Agents use the model's built-in search when it has one, and Juno's search otherwise.") }
        }
        .task { mode = await world.savedWebSearch() }
    }

    private func save(_ new: String) {
        let old = mode
        mode = new
        Task { @MainActor in
            do { try await world.saveWebSearch(new); error = nil }
            catch { mode = old; self.error = error.localizedDescription }
        }
    }
}

// MARK: - Default model

/// Provider (keyed ones) → model from that provider's catalog (pushed searchable list). Saves `models.providerId` +
/// `defaultModel`; thinking levels are per job, in `TierModelsSection`.
private struct DefaultModelSection: View {
    @Environment(World.self) private var world
    var providers: [ModelProvider]
    var platformDefault: Bool
    @State private var saved = ModelChoice()
    @State private var chosen = ModelChoice()
    @State private var stale = false
    @State private var catalog: ProviderCatalog?
    @State private var catalogError: String?
    /// The provider ids the saved settings were last read for. Coming back from the pushed model list re-runs
    /// `.task`; reading again then would overwrite the unsaved choice with the saved one.
    @State private var loadedFor: [String]?
    @State private var saving = false
    @State private var saveError: String?
    @State private var justSaved = false

    private var keyed: [ModelProvider] { providers.filter { $0.hasKey && !$0.isSystemOne } }
    private var dirty: Bool { chosen != saved }
    private var canSave: Bool { dirty && (chosen.providerId.isEmpty || !chosen.model.isEmpty) }

    var body: some View {
        Section {
            if keyed.isEmpty && !platformDefault {
                Text("Add a provider above to choose a model.").foregroundStyle(Theme.fgMuted)
            } else {
                if stale { Text("The provider you chose as default no longer exists. Choose a provider and model.").text(.sm).foregroundStyle(Theme.warning) }
                Picker("Provider", selection: Binding(get: { chosen.providerId }, set: pick)) {
                    Text(platformDefault ? "Service default" : "Choose a provider").tag("")
                    ForEach(keyed) { Text($0.name).tag($0.id) }
                }
                .accessibilityIdentifier("default-provider")
                if !chosen.providerId.isEmpty {
                    if let catalog {
                        NavigationLink {
                            ModelPickerList(items: catalog.items, selection: Binding(get: { chosen.model }, set: { chosen.model = $0 }))
                        } label: {
                            LabeledContent("Model", value: catalog.items.first { $0.id == chosen.model }?.name ?? (chosen.model.isEmpty ? "Choose a model" : chosen.model))
                        }
                        .accessibilityIdentifier("default-model")
                    } else if let catalogError {
                        Text(catalogError).text(.sm).foregroundStyle(Theme.fgMuted)
                        Button("Retry") { Task { await loadCatalog() } }
                    } else {
                        HStack(spacing: 8) { ProgressView(); Text("Loading models…").foregroundStyle(Theme.fgMuted) }
                    }
                }
                HStack {
                    if justSaved { Label("Saved", systemImage: "checkmark").text(.sm).foregroundStyle(Theme.fgMuted) }
                    Spacer()
                    if !saved.providerId.isEmpty { Button("Clear default", role: .destructive, action: clear).disabled(saving) }
                    Button(action: save) { if saving { ProgressView() } else { Text("Save") } }
                        .buttonStyle(WebButton(variant: .primary, size: .sm))
                        .disabled(!canSave || saving)
                        .accessibilityIdentifier("default-save")
                }
                if let saveError { Text(saveError).text(.sm).foregroundStyle(Theme.danger) }
            }
        } header: { Text("Default model") } footer: {
            Text("Applies to every agent's next task. Current tasks keep their model.")
        }
        .task(id: providers.map(\.id)) { await loadSettings() }
    }

    private func pick(_ id: String) {
        guard id != chosen.providerId else { return }
        chosen = ModelChoice(providerId: id)
        catalog = nil; catalogError = nil; justSaved = false
        Task { await loadCatalog() }
    }

    private func loadSettings() async {
        let ids = providers.map(\.id)
        guard loadedFor != ids else { return }
        var start = await world.savedModelChoice() ?? ModelChoice()
        stale = !start.providerId.isEmpty && !providers.contains { $0.id == start.providerId }
        if !keyed.contains(where: { $0.id == start.providerId }) { start = ModelChoice() }
        saved = start
        // Nothing saved and no service default: the only keyed provider is the obvious choice.
        if start.providerId.isEmpty, !platformDefault, keyed.count == 1 { chosen = ModelChoice(providerId: keyed[0].id) }
        else { chosen = start }
        loadedFor = ids
        if !chosen.providerId.isEmpty { await loadCatalog() }
    }

    private func loadCatalog() async {
        guard !chosen.providerId.isEmpty else { return }
        let id = chosen.providerId
        do {
            let result = try await world.providerCatalog(id)
            guard id == chosen.providerId else { return }
            catalog = result; catalogError = nil
        } catch {
            guard id == chosen.providerId else { return }
            if case APIError.api(_, "MODEL_CATALOG_UNAVAILABLE", _) = error { catalogError = "This provider's model list isn't available right now." }
            else { catalogError = "Couldn't load models." }
        }
    }

    private func write(_ value: ModelChoice, then: @escaping () -> Void) {
        saving = true; saveError = nil
        Task { @MainActor in
            defer { saving = false }
            do {
                try await world.saveModelChoice(value)
                then()
            } catch {
                saveError = providerErrorMessage(error)
            }
        }
    }

    private func save() {
        write(chosen) { saved = chosen; stale = false; justSaved = true }
    }

    private func clear() {
        write(ModelChoice()) { saved = ModelChoice(); chosen = ModelChoice(); catalog = nil; justSaved = false }
    }
}

/// A pushed, searchable model list: provider catalogs run to hundreds of entries.
struct ModelPickerList: View {
    @Environment(\.dismiss) private var dismiss
    var items: [ProviderCatalog.Item]
    @Binding var selection: String
    @State private var query = ""

    private var shown: [ProviderCatalog.Item] {
        query.isEmpty ? items : items.filter { $0.name.localizedCaseInsensitiveContains(query) || $0.id.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        List {
            Group {
                ForEach(shown) { item in
                    Button { selection = item.id; dismiss() } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.name).foregroundStyle(Theme.fg)
                                if item.supportsImages == true { Text("Accepts images").text(.sm).foregroundStyle(Theme.fgMuted) }
                            }
                            Spacer()
                            if selection == item.id { Image(systemName: "checkmark").foregroundStyle(Theme.fg) }
                        }
                    }
                }
                if shown.isEmpty { Text("No model matches that.").foregroundStyle(Theme.fgMuted) }
            }
            .listRowBackground(Theme.muted)
        }
        .webGrouped()
        .searchable(text: $query, prompt: "Search models")
        .pageHeader("Choose a model")
    }
}
