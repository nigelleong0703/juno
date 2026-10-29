import AuthenticationServices
import SwiftUI

// Adding an app. One installer serves every place that can start it (the app's page, the chat connect card, a routine that waits
// on an app, an expired sign-in): a work app signs in through the system sheet, which closes itself when the server redirects to
// `juno://connectors`; an app that asks for values (an API key, a workspace URL) opens a JunoSheet form first; a chat app opens the
// platform's install link and the page watches until the workspace or bot appears. Telegram and Feishu bots belong to an agent, so
// they ask which one.

@MainActor @Observable
final class AppInstaller {
    var busy = false
    /// The last failure, for the place that started the install to show under its button.
    var error: String?
    /// A chat app being finished on the platform: the app's id while the page waits for the workspace or bot to appear.
    var waiting: String?
    var form: ConfigRequest?
    var customForm = false
    var picking: Pick?

    struct ConfigRequest: Identifiable {
        var app: Contract.App
        /// The account to sign in to again; nil adds a new one.
        var connectionId: String?
        var id: String { app.id }
    }

    enum Pick: Identifiable {
        case agent(Contract.App)
        case region(Contract.App, agentId: String)
        var id: String {
            switch self {
            case .agent(let app): "agent-\(app.id)"
            case .region(let app, let agentId): "region-\(app.id)-\(agentId)"
            }
        }
    }

    @ObservationIgnored private var world: World?
    @ObservationIgnored private var web: WebAuthenticationSession?
    @ObservationIgnored private var open: OpenURLAction?
    @ObservationIgnored private var watch: Task<Void, Never>?

    func attach(world: World, web: WebAuthenticationSession, open: OpenURLAction) {
        self.world = world; self.web = web; self.open = open
    }

    // MARK: Starting

    /// Adds the app (or signs in again to `connectionId`): the sheet it needs, or the browser, or the platform.
    func start(_ app: Contract.App, connectionId: String? = nil) {
        error = nil
        switch app.categoryValue {
        case .work:
            if !app.fields.isEmpty { form = ConfigRequest(app: app, connectionId: connectionId) }
            else { run { try await self.installWork(app, values: nil, connectionId: connectionId) } }
        case .custom:
            if let connectionId { run { try await self.installWork(app, values: nil, connectionId: connectionId) } } else { customForm = true }
        case .chat:
            startChat(app)
        case .web:
            if app.canAdd { run { try await self.installWork(app, values: nil, connectionId: connectionId) } }
        case nil, .unknown:
            break
        }
    }

    /// Chat apps: Slack and Discord install the shared Juno bot into a workspace; Telegram and Feishu make a bot for one agent.
    private func startChat(_ app: Contract.App) {
        switch ChannelPlatform(kind: app.id) {
        case .slack, .discord:
            if app.workspaceInstall == true { connectChat(app, Contract.InstallAppChatInput(mode: "oauth")) }
            else { error = "Juno can't be added to a \(app.displayName) workspace on this server yet." }
        case .telegram, .feishu:
            picking = .agent(app)
        case nil:
            error = "\(app.displayName) can't be added from the phone yet."
        }
    }

    func choose(agent agentId: String, for app: Contract.App) {
        if ChannelPlatform(kind: app.id) == .feishu { picking = .region(app, agentId: agentId) }
        else { connectChat(app, Contract.InstallAppChatInput(agentId: agentId, mode: "managed")) }
    }

    func choose(domain: String, agentId: String, for app: Contract.App) {
        connectChat(app, Contract.InstallAppChatInput(agentId: agentId, mode: "register", domain: domain))
    }

    /// A chat install, from here or from an agent's own-bot sheet. The platform's link opens and the page waits for the result.
    func connectChat(_ app: Contract.App, _ input: Contract.InstallAppChatInput) {
        run {
            guard let world = self.world else { return }
            let known = Set(app.accounts.map(\.id))
            let reply = try await world.installApp(app.id, input)
            guard reply.installation == nil, reply.pending != nil || reply.openUrl != nil else { return }
            if let link = reply.openUrl.flatMap({ URL(string: $0) }) { self.open?(link) }
            self.wait(for: app.id, known: known)
        }
    }

    /// Looks at a custom MCP server by address before it is added.
    func probeCustom(url: String) async throws -> Contract.ProbeCustomAppResponse {
        guard let world else { throw APIError.notSignedIn }
        return try await world.probeCustomApp(url)
    }

    /// Adds the custom MCP server the person reviewed (`review.confirm` goes with it); the server may then need a sign-in.
    func addCustom(name: String, url: String, review: CustomAppReview) async -> CustomAddResult {
        guard let world else { return .failed("Not signed in.") }
        do {
            let reply = try await world.installApp("custom", Contract.InstallAppCustomInput(name: name, transport: "http", url: url, confirm: review.confirm, returnUrl: World.appReturnUrl))
            customForm = false
            try await finish(reply, appId: reply.appId ?? "custom")
            return .added
        } catch APIError.api(_, let code, _) where code == "CUSTOM_PROBE_REQUIRED" || code == "CUSTOM_PROBE_CHANGED" {
            return .recheck(changed: code == "CUSTOM_PROBE_CHANGED")
        } catch APIError.api(_, "CUSTOM_NOT_USABLE", let message) {
            return .notUsable(message)
        } catch { return .failed(error.localizedDescription) }
    }

    // MARK: Work apps

    /// The form's submit: the failure text goes back to the sheet; success closes it.
    func submit(_ request: ConfigRequest, values: [String: ConfigValue]) async -> String? {
        do {
            try await installWork(request.app, values: values, connectionId: request.connectionId)
            form = nil
            return nil
        } catch { return error.localizedDescription }
    }

    private func installWork(_ app: Contract.App, values: [String: ConfigValue]?, connectionId: String?) async throws {
        guard let world else { return }
        let body = InstallWorkBody(returnUrl: World.appReturnUrl, userConfig: values, connectionId: connectionId)
        // A custom server signs in again through the `custom` install, with its connection id.
        let reply = try await world.installApp(app.categoryValue == .custom ? "custom" : app.id, body)
        try await finish(reply, appId: reply.appId ?? app.id)
    }

    /// Opens the sign-in page of a work or custom app in the system sheet and reloads when it closes. Cancelling is not an error.
    private func finish(_ reply: Contract.InstallAppResponse, appId: String) async throws {
        guard let world else { return }
        if let link = reply.openUrl.flatMap({ URL(string: $0) }), let web {
            do { _ = try await web.authenticate(using: link, callback: .customScheme("juno"), preferredBrowserSession: .shared, additionalHeaderFields: [:]) }
            catch let failure as ASWebAuthenticationSessionError where failure.code == .canceledLogin {}
        }
        await world.reloadApps(appId)
    }

    // MARK: Waiting for a chat install

    private func wait(for appId: String, known: Set<String>) {
        watch?.cancel()
        waiting = appId
        watch = Task { [weak self] in
            guard let world = self?.world else { return }
            let outcome = await world.waitForInstall(appId, known: known)
            guard !Task.isCancelled else { return }
            self?.waiting = nil
            switch outcome {
            case .connected: break
            case .failed(let message): self?.error = message ?? "The install did not finish. Try again."
            case .timedOut: self?.error = "This is taking too long. Try again."
            }
        }
    }

    func stopWaiting() { watch?.cancel(); waiting = nil }

    private func run(_ work: @escaping () async throws -> Void) {
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do { try await work() }
            catch where error.isCancellation {}
            catch { self.error = error.localizedDescription }
        }
    }
}

extension View {
    /// Gives the view an installer's sheets and questions: the values form, the custom server form and the "which agent" asks.
    func appInstaller(_ installer: AppInstaller) -> some View { modifier(AppInstallerHost(installer: installer)) }
}

private struct AppInstallerHost: ViewModifier {
    @Environment(World.self) private var world
    @Environment(\.webAuthenticationSession) private var web
    @Environment(\.openURL) private var open
    @Bindable var installer: AppInstaller

    func body(content: Content) -> some View {
        content
            .onAppear { installer.attach(world: world, web: web, open: open) }
            .sheet(item: $installer.form) { AppConfigSheet(request: $0, installer: installer) }
            .sheet(isPresented: $installer.customForm) { CustomAppSheet(installer: installer) }
            .confirmationDialog("Which agent is the bot for?", isPresented: asking(agent: true), titleVisibility: .visible, presenting: installer.picking) { pick in
                if case .agent(let app) = pick {
                    ForEach(world.agents) { agent in Button(agent.name ?? "Agent") { installer.choose(agent: agent.id, for: app) } }
                }
            }
            .confirmationDialog("Which region?", isPresented: asking(agent: false), titleVisibility: .visible, presenting: installer.picking) { pick in
                if case .region(let app, let agentId) = pick {
                    Button("Feishu") { installer.choose(domain: "feishu", agentId: agentId, for: app) }
                    Button("Lark") { installer.choose(domain: "lark", agentId: agentId, for: app) }
                }
            } message: { _ in Text("Feishu for accounts on feishu.cn, Lark for accounts on larksuite.com.") }
    }

    private func asking(agent: Bool) -> Binding<Bool> {
        Binding(get: {
            switch installer.picking {
            case .agent: agent
            case .region: !agent
            case nil: false
            }
        }, set: { if !$0 { installer.picking = nil } })
    }
}

/// The values an app asks for when it is added, as a form built from its `userConfig`: a secret is a secure input.
struct AppConfigSheet: View {
    @Environment(\.dismiss) private var dismiss
    var request: AppInstaller.ConfigRequest
    var installer: AppInstaller
    @State private var form: UserConfigForm
    @State private var busy = false
    @State private var failure: String?

    init(request: AppInstaller.ConfigRequest, installer: AppInstaller) {
        self.request = request
        self.installer = installer
        _form = State(initialValue: UserConfigForm(fields: request.app.fields))
    }

    var body: some View {
        let name = request.app.displayName
        let secret = request.app.fields.contains { $0.sensitive == true }
        JunoSheet(icon: "key", title: request.connectionId == nil ? "Add \(name)" : "Sign in to \(name)", guidance: nil,
                  note: secret ? "Stored encrypted and never shown again." : nil, primary: "Connect", primaryEnabled: form.isValid, loading: busy,
                  long: request.app.fields.count > 2, id: "app-config", onPrimary: { Task { await submit() } }, onCancel: { dismiss() }) {
            if let failure { JunoMessage(text: failure) }
            ForEach(request.app.fields, id: \.key) { field in
                if let key = field.key {
                    JunoFormField(label: field.title ?? key, optional: field.required != true, help: field.description,
                                  error: form.errors[key].flatMap { $0 == "Required" ? nil : $0 }) { input(field, key) }
                }
            }
        }
        .interactiveDismissDisabled(busy)
    }

    @ViewBuilder private func input(_ field: Contract.UserConfigField, _ key: String) -> some View {
        let text = Binding(get: { form.text[key] ?? "" }, set: { form.text[key] = $0 })
        if field.type == "boolean" {
            Toggle(isOn: Binding(get: { form.flags[key] ?? false }, set: { form.flags[key] = $0 })) {
                Text((form.flags[key] ?? false) ? "On" : "Off").foregroundStyle(Theme.fg)
            }
            .tint(Theme.success).inputField()
        } else if let options = field.options, !options.isEmpty {
            JunoPickerRow(value: text.wrappedValue, options: options, id: "app-config-\(key)") { text.wrappedValue = $0 }
        } else if field.sensitive == true {
            SecureField(field.title ?? key, text: text).textInputAutocapitalization(.never).autocorrectionDisabled()
                .accessibilityIdentifier("app-config-\(key)").inputField()
        } else {
            TextField(field.title ?? key, text: text).textInputAutocapitalization(.never).autocorrectionDisabled()
                .keyboardType(field.type == "number" ? .decimalPad : .default)
                .accessibilityIdentifier("app-config-\(key)").inputField()
        }
    }

    @MainActor
    private func submit() async {
        busy = true; defer { busy = false }
        failure = await installer.submit(request, values: form.values)
        if failure == nil { dismiss() }
    }
}

/// A custom app: any remote MCP server by its address. The address is checked first; the second step shows how the server signs people
/// in and its tools, each marked Read or Change (a tap on a row switches it), and only then is it added with that confirmation.
struct CustomAppSheet: View {
    private static let toolRows = 8
    @Environment(\.dismiss) private var dismiss
    var installer: AppInstaller
    @State private var name = ""
    @State private var url = ""
    @State private var review: CustomAppReview?
    @State private var showAllTools = false
    @State private var busy = false
    @State private var failure: String?

    private var trimmedName: String { name.trimmingCharacters(in: .whitespaces) }
    private var trimmedUrl: String { url.trimmingCharacters(in: .whitespaces) }

    var body: some View {
        let ready = !trimmedName.isEmpty && !trimmedUrl.isEmpty
        JunoSheet(icon: "puzzlepiece.extension", title: "Add a custom app", guidance: review == nil ? "Any remote MCP server, by its address." : nil,
                  primary: review == nil ? "Check" : "Add", primaryEnabled: ready, loading: busy, cancel: review == nil ? "Cancel" : "Back",
                  long: (review?.tools.count ?? 0) > 3, id: "custom-app", onPrimary: { Task { await primary() } },
                  onCancel: { if review == nil { dismiss() } else { review = nil; failure = nil } }) {
            if let failure { JunoMessage(text: failure) }
            if let review {
                reviewStep(review)
            } else {
                JunoFormField(label: "Name") {
                    TextField("Name", text: $name).accessibilityIdentifier("custom-app-name").inputField()
                }
                JunoFormField(label: "Address") {
                    TextField("https://mcp.example.com/mcp", text: $url).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("custom-app-url").inputField()
                }
            }
        }
        .interactiveDismissDisabled(busy)
    }

    @ViewBuilder private func reviewStep(_ review: CustomAppReview) -> some View {
        Text(review.loginLine).text(.md).foregroundStyle(Theme.fg)
        if review.isOAuth {
            Text("Its tools are listed after you sign in. Until you mark them, every tool asks first.").text(.sm).foregroundStyle(Theme.fgMuted)
        }
        if !review.tools.isEmpty {
            Text("Choose what each tool does. A tool that changes things asks first; tap a row to switch it.").text(.sm).foregroundStyle(Theme.fgMuted)
            let shown = showAllTools ? review.tools : Array(review.tools.prefix(Self.toolRows))
            VStack(alignment: .leading, spacing: 0) {
                ForEach(shown, id: \.name) { tool in
                    if let toolName = tool.name {
                        let change = review.isChange(toolName)
                        Button { self.review?.flip(toolName) } label: {
                            HStack(spacing: 12) {
                                Text(tool.title.flatMap { $0.isEmpty ? nil : $0 } ?? toolName).text(.md).foregroundStyle(Theme.fg).multilineTextAlignment(.leading)
                                Spacer(minLength: 8)
                                Text(change ? "Changes" : "Read").text(.sm).foregroundStyle(change ? Theme.warning : Theme.fgSubtle)
                            }
                            .padding(.vertical, 10).contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("custom-app-tool-\(toolName)")
                    }
                }
            }
            ShowMore(shown: shown.count, total: review.tools.count) { withAnimation { showAllTools = true } }
        }
    }

    @MainActor
    private func primary() async {
        if let review { await add(review) } else { await check() }
    }

    /// Looks at the server; a usable one moves to the review step, an unusable one says why and the address stays.
    @MainActor
    private func check(notice: String? = nil) async {
        busy = true; defer { busy = false }
        failure = nil
        do {
            let probe = try await installer.probeCustom(url: trimmedUrl)
            if probe.usable == false {
                review = nil
                failure = probe.problem ?? "This server cannot be added."
                return
            }
            review = CustomAppReview(probe: probe)
            showAllTools = false
            failure = notice
        } catch {
            review = nil
            failure = error.localizedDescription
        }
    }

    @MainActor
    private func add(_ review: CustomAppReview) async {
        busy = true
        let result = await installer.addCustom(name: trimmedName, url: trimmedUrl, review: review)
        busy = false
        switch result {
        case .added: dismiss()
        case .failed(let message): failure = message
        case .notUsable(let message): self.review = nil; failure = message
        case .recheck(let changed):
            await check(notice: changed ? "The server now asks for something different. Check what it needs and confirm again." : nil)
        }
    }
}
