import SwiftUI

// Agent › Apps (replaces the agent's Channels section and its per-connector switches): the apps the owner added in Apps, turned on or
// off for this agent with their actions policy, and where people reach it on chat platforms (the shared Juno bot's workspaces and the
// agent's own bots). Wording follows the web app.

struct AgentAppsSection: View {
    @Environment(World.self) private var world
    var agentId: String
    @State private var showAllApps = false
    @State private var showAllPlaces = false
    @State private var choosingPlatform = false
    @State private var removing: Place?
    @State private var failure: String?
    @State private var installer = AppInstaller()

    private static let cap = 4

    /// One chat-app workspace (or this agent's own bot) with whether the agent is in it.
    struct Place: Identifiable {
        var app: Contract.App
        var installation: Contract.AppInstallation
        var id: String { "\(app.id)|\(installation.id)" }
        var member: (agentId: String, handle: String?, status: String?, message: String?)?
        var isOwnBot: Bool { installation.agentId != nil }
        /// A Slack or Discord bot made with the agent's own token: it no longer runs, and comes back through the shared Juno app.
        var needsSharedApp: Bool { isOwnBot && installation.status != "connected" && (app.id == "slack" || app.id == "discord") }
    }

    var body: some View {
        let name = world.agent(agentId)?.name ?? "this agent"
        VStack(alignment: .leading, spacing: 26) {
            canUse(name)
            reach(name)
            if let line = failure ?? installer.error { Text(line).text(.sm).foregroundStyle(Theme.danger) }
        }
        .task { await world.refreshApps() }
        .appInstaller(installer)
        .confirmationDialog("Which platform?", isPresented: $choosingPlatform, titleVisibility: .visible) {
            // Telegram and Feishu make a bot for the agent and you only confirm it there; Slack and Discord have one shared Juno app.
            ForEach([ChannelPlatform.telegram, .feishu]) { platform in
                Button(platform.name) { if let app = world.app(platform.rawValue) { installer.choose(agent: agentId, for: app) } }
            }
        } message: { Text("Juno makes \(name) a bot of its own there. You only confirm it.") }
        .confirmationDialog(removing.map { "Remove \($0.installation.label ?? $0.app.displayName)?" } ?? "", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
                            titleVisibility: .visible, presenting: removing) { place in
            Button("Remove", role: .destructive) { run { try await world.removeInstallation(place.app.id, place.installation.id) } }
        } message: { _ in Text("\(name) stops answering there. You can add it again later.") }
    }

    // MARK: Can use

    @ViewBuilder private func canUse(_ name: String) -> some View {
        let added = (world.apps ?? []).filter { $0.isPerAgent && $0.isAdded }
        VStack(alignment: .leading, spacing: 10) {
            TabHeader(title: "\(name) can use")
            if world.apps == nil {
                if world.appsLoadFailed {
                    Text("Couldn't load your apps.").text(.base).foregroundStyle(Theme.fgMuted)
                    Button("Try again") { Task { await world.refreshApps() } }.buttonStyle(WebButton(variant: .secondary, size: .regular))
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
            } else if added.isEmpty {
                EmptyLine(text: "No work apps added yet.")
            } else {
                ForEach(showAllApps ? added : Array(added.prefix(Self.cap))) { app in AgentAppRow(app: app, agentId: agentId, installer: installer, run: run) }
                ShowMore(shown: showAllApps ? added.count : min(Self.cap, added.count), total: added.count) { withAnimation { showAllApps = true } }
            }
            Text("Only apps you added in Apps show here.").text(.xs).foregroundStyle(Theme.fgSubtle)
            Button { openApps() } label: { Label("Add apps", systemImage: "plus") }
                .buttonStyle(WebButton(variant: .secondary, size: .regular))
                .accessibilityIdentifier("agent-apps-add")
        }
    }

    // MARK: Where people reach it

    private var places: [Place] {
        let chat = (world.apps ?? []).filter(\.isChat)
        let all = chat.flatMap { app in
            app.accounts.filter { $0.agentId == nil || $0.agentId == agentId }.map { installation -> Place in
                var place = Place(app: app, installation: installation)
                if let member = (installation.agents ?? []).first(where: { $0.agentId == agentId }) {
                    place.member = (agentId, member.handle, member.handleStatus, member.statusMessage)
                }
                return place
            }
        }
        return all.filter { $0.member != nil } + all.filter { $0.member == nil }
    }

    @ViewBuilder private func reach(_ name: String) -> some View {
        let all = places
        VStack(alignment: .leading, spacing: 10) {
            TabHeader(title: "Where people reach \(name)")
            if world.apps != nil && all.isEmpty { EmptyLine(text: "Not on any messaging app yet.") }
            ForEach(showAllPlaces ? all : Array(all.prefix(Self.cap))) { place in placeRow(place, name: name) }
            ShowMore(shown: showAllPlaces ? all.count : min(Self.cap, all.count), total: all.count) { withAnimation { showAllPlaces = true } }
            Button { choosingPlatform = true } label: { Label("Give \(name) its own bot", systemImage: "plus") }
                .buttonStyle(WebButton(variant: .secondary, size: .regular))
                .accessibilityIdentifier("agent-apps-own-bot")
            Button { openApps() } label: { Text("Add Slack, Discord\u{2026} in Apps").text(.base).foregroundStyle(Theme.fgMuted) }
                .buttonStyle(.plain)
        }
    }

    private func placeRow(_ place: Place, name: String) -> some View {
        let platform = ChannelPlatform(kind: place.app.id)
        let title = [place.app.displayName, place.installation.label].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " \u{00B7} ")
        return HStack(spacing: 12) {
            if let platform { ChannelBadge(platform: platform, size: 32) } else { AppIcon(app: place.app, size: 32) }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).text(.md, .medium).foregroundStyle(Theme.fg).lineLimit(1)
                if place.needsSharedApp {
                    Text("Reconnect through the shared app").text(.sm).foregroundStyle(Theme.warning).lineLimit(2)
                } else if let member = place.member {
                    Text(member.handle.map { "@\($0)" } ?? "No @name yet").text(.sm).foregroundStyle(Theme.fgMuted).lineLimit(1)
                    if let message = member.message, !message.isEmpty {
                        Text(message).text(.sm).foregroundStyle(Theme.warning).fixedSize(horizontal: false, vertical: true)
                    }
                } else {
                    Text("Not in this workspace").text(.sm).foregroundStyle(Theme.fgSubtle)
                }
            }
            Spacer(minLength: 8)
            if place.isOwnBot {
                if place.needsSharedApp {
                    Button("Reconnect") { installer.start(place.app) }
                        .buttonStyle(WebButton(variant: .secondary, size: .xs))
                        .accessibilityIdentifier("agent-place-reconnect-\(place.id)")
                }
                Menu {
                    Button("Remove", systemImage: "xmark.circle", role: .destructive) { removing = place }
                } label: { Image(systemName: "ellipsis").foregroundStyle(Theme.fgMuted).frame(width: 36, height: 36).contentShape(.rect) }
                    .accessibilityLabel("Options for \(title)")
            } else if place.member != nil {
                Toggle("\(name) in \(title)", isOn: Binding(get: { true }, set: { _ in
                    run { try await world.setWorkspaceAgent(place.app.id, installation: place.installation.id, agent: agentId, enabled: false) }
                })).labelsHidden().tint(Theme.success)
            } else {
                Button("Add \(name)") { run { try await world.setWorkspaceAgent(place.app.id, installation: place.installation.id, agent: agentId, enabled: true) } }
                    .buttonStyle(WebButton(variant: .secondary, size: .xs))
            }
        }
        .accessibilityIdentifier("agent-place-\(place.id)")
    }

    private func openApps() {
        world.agentPage = nil
        world.pendingRoute = .apps
    }

    private func run(_ work: @escaping () async throws -> Void) {
        failure = nil
        Task { @MainActor in
            do { try await work() } catch where !error.isCancellation { failure = error.localizedDescription } catch {}
        }
    }
}

/// How an app's Actions policy reads: a row's subtitle ("Asks before changes") and a choice in the app's sheet (title and line).
extension Contract.ActionsPolicy {
    var stateWords: String {
        switch self {
        case .ask, .unknown: "Asks before changes"
        case .allow: "Changes without asking"
        case .off: "Read only"
        }
    }

    var choiceTitle: String {
        switch self {
        case .ask, .unknown: "Ask first"
        case .allow: "Allow"
        case .off: "Don't allow changes"
        }
    }

    func choiceLine(_ agent: String) -> String {
        switch self {
        case .ask, .unknown: "\(agent) asks you before creating or editing anything."
        case .allow: "\(agent) makes changes without asking."
        case .off: "\(agent) can only read and search."
        }
    }
}

/// One work or custom app for this agent: icon, name, its switch, and under the name how it stands: an expired sign-in (warning
/// colour) first, else what it may change in words; an app that cannot change anything keeps its blurb. A tap on the row (not the
/// switch) opens the app's sheet (`AgentAppSheet`).
private struct AgentAppRow: View {
    @Environment(World.self) private var world
    var app: Contract.App
    var agentId: String
    var installer: AppInstaller
    var run: (@escaping () async throws -> Void) -> Void
    @State private var open = false
    /// "Sign in again" was chosen in the sheet: the installer starts once the sheet is gone.
    @State private var signIn = false

    var body: some View {
        let on = app.isEnabled(for: agentId)
        HStack(spacing: 12) {
            Button { open = true } label: {
                HStack(spacing: 12) {
                    AppIcon(app: app, size: 32)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(app.displayName).text(.md, .medium).foregroundStyle(Theme.fg).lineLimit(1)
                        if app.needsSignIn {
                            Text("Sign-in expired \u{00B7} sign in again").text(.sm).foregroundStyle(Theme.warning).lineLimit(1)
                        } else if app.grants?.actions != false {
                            Text(app.policy(for: agentId).stateWords).text(.sm).foregroundStyle(Theme.fgMuted).lineLimit(1)
                        } else if let blurb = app.blurb, !blurb.isEmpty {
                            Text(blurb).text(.sm).foregroundStyle(Theme.fgMuted).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 8)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("agent-app-row-\(app.id)")
            Toggle(app.displayName, isOn: Binding(get: { on }, set: { new in run { try await world.setAgentApp(agentId, app.id, enabled: new) } }))
                .labelsHidden().tint(Theme.success)
                .accessibilityIdentifier("agent-app-\(app.id)")
        }
        .sheet(isPresented: $open, onDismiss: {
            guard signIn else { return }
            signIn = false
            installer.start(app, connectionId: app.expiredAccount?.id)
        }) {
            AgentAppSheet(appId: app.id, agentId: agentId, onSignIn: { signIn = true })
        }
    }
}

/// One app for this agent in the app's sheet format, titled with the app's name: the switch "<Agent> can use <App>" and, only for an
/// app that can change things, "When it changes things" as a single-select list (Ask first, Allow, Don't allow changes) with a line
/// each. There is nothing to save: every change goes out at once (shown at once, put back if the server refuses it).
private struct AgentAppSheet: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var appId: String
    var agentId: String
    var onSignIn: () -> Void
    @State private var failure: String?

    var body: some View {
        let app = world.app(appId)
        let name = world.agent(agentId)?.name ?? "This agent"
        let on = app?.isEnabled(for: agentId) ?? false
        JunoSheet(icon: "puzzlepiece.extension", title: app?.displayName ?? "App", cancel: "Close", fitsContent: true, id: "agent-app-sheet",
                  onCancel: { dismiss() }) {
            if let app {
                if let failure { JunoMessage(text: failure) }
                Toggle("\(name) can use \(app.displayName)", isOn: Binding(get: { on }, set: { new in apply(app, enabled: new) }))
                    .tint(Theme.success)
                    .accessibilityIdentifier("agent-app-sheet-switch")
                    .inputField()
                if app.needsSignIn {
                    Button { onSignIn(); dismiss() } label: { Text("Sign in again").frame(maxWidth: .infinity) }
                        .buttonStyle(WebButton(variant: .secondary, size: .large))
                        .accessibilityIdentifier("agent-app-sheet-signin")
                }
                if app.grants?.actions != false {
                    JunoFormField(label: "When it changes things") {
                        VStack(alignment: .leading, spacing: 14) {
                            ForEach([Contract.ActionsPolicy.ask, .allow, .off], id: \.self) { policy in
                                VStack(alignment: .leading, spacing: 6) {
                                    JunoCheckRow(title: policy.choiceTitle, selected: app.policy(for: agentId) == policy, id: "agent-app-policy-\(policy.rawValue)") {
                                        apply(app, enabled: true, policy: policy)
                                    }
                                    Text(policy.choiceLine(name)).text(.xs).foregroundStyle(Theme.fgMuted).fixedSize(horizontal: false, vertical: true)
                                }
                            }
                        }
                        .disabled(!on)
                        .opacity(on ? 1 : 0.5)
                    }
                }
            }
        }
    }

    private func apply(_ app: Contract.App, enabled: Bool, policy: Contract.ActionsPolicy? = nil) {
        failure = nil
        Task { @MainActor in
            do { try await world.setAgentApp(agentId, app.id, enabled: enabled, policy: policy) }
            catch where !error.isCancellation { failure = error.localizedDescription }
            catch {}
        }
    }
}

