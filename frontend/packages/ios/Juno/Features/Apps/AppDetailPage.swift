import SwiftUI

/// One app, pushed from the Apps page (owner-approved 2026-10-26): icon, name, "category · state" and Connect (Manage once it is
/// added); what it is; "Try asking" prompts that start a new chat; the agents that may use it (tap to add or remove); what agents
/// can do through it, each line marked Read or Asks first; the Actions policy per agent; the accounts or workspaces it is added
/// with; the information; Remove app. No boxes: sections are a title over plain rows.
struct AppDetailPage: View {
    @Environment(World.self) private var world
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    var appId: String
    @State private var installer = AppInstaller()
    @State private var failure: String?
    @State private var removing: Contract.AppInstallation?
    @State private var removingApp = false
    @State private var choosing: Agent?
    @State private var showAllCapabilities = false
    @State private var showAllAccounts = false

    private static let cap = 5

    var body: some View {
        Group {
            if let app = world.app(appId) {
                content(app)
            } else if world.apps == nil {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView("This app is no longer available", systemImage: "puzzlepiece.extension")
            }
        }
        .background(Theme.canvas)
        .pageHeader(world.app(appId)?.displayName ?? "App")
        .appInstaller(installer)
        .task {
            if world.apps == nil { await world.refreshApps() }
            await world.refreshApp(appId)
        }
        // The sign-in happens in a browser; coming back to the app shows the new state.
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await world.reloadApps(appId) } } }
    }

    private func content(_ app: Contract.App) -> some View {
        let detail = world.appDetails[appId]
        return ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    header(app, proxy: proxy)
                    if let note = notice(app) { Text(note).text(.sm).foregroundStyle(Theme.warning).fixedSize(horizontal: false, vertical: true) }
                    if let line = failure ?? installer.error { Text(line).text(.sm).foregroundStyle(Theme.danger).fixedSize(horizontal: false, vertical: true) }
                    if let text = app.description, !text.isEmpty {
                        Text(text).text(.lg).foregroundStyle(Theme.fgMuted).fixedSize(horizontal: false, vertical: true)
                    }
                    tryAsking(app)
                    agentsRow(app)
                    capabilities(detail)
                    if app.categoryValue == .web && !app.isComingSoon && (detail?.capabilities ?? []).isEmpty {
                        Text("Reads public pages. No sign-in.").text(.sm).foregroundStyle(Theme.fgMuted)
                    }
                    actions(app)
                    accounts(app, detail: detail).id("accounts")
                    information(app)
                    if app.isAdded {
                        Button("Remove app", role: .destructive) { removingApp = true }
                            .text(.base, .medium)
                            .accessibilityIdentifier("app-remove")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 40)
            }
            .refreshable { await world.reloadApps(appId) }
        }
        .confirmationDialog("Remove \(app.displayName)?", isPresented: $removingApp, titleVisibility: .visible) {
            Button("Remove app", role: .destructive) { run { try await world.removeApp(app) } }
        } message: { Text("Every account is signed out and your agents lose it.") }
        .confirmationDialog(removing.map { "Remove \($0.label ?? app.displayName)?" } ?? "", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
                            titleVisibility: .visible, presenting: removing) { account in
            Button("Remove", role: .destructive) { run { try await world.removeInstallation(app.id, account.id) } }
        } message: { _ in Text(app.isChat ? "Your agents stop answering there. You can add it again later." : "Your agents lose this account.") }
        .confirmationDialog(choosing.map { "\($0.name ?? "Agent") in which workspace?" } ?? "", isPresented: Binding(get: { choosing != nil }, set: { if !$0 { choosing = nil } }),
                            titleVisibility: .visible, presenting: choosing) { agent in
            ForEach(app.accounts.filter { $0.agentId == nil }) { workspace in
                let on = (workspace.agents ?? []).contains { $0.agentId == agent.id }
                Button("\(on ? "Remove from" : "Add to") \(workspace.label ?? "workspace")") {
                    run { try await world.setWorkspaceAgent(app.id, installation: workspace.id, agent: agent.id, enabled: !on) }
                }
            }
        }
    }

    // MARK: Header

    private func header(_ app: Contract.App, proxy: ScrollViewProxy) -> some View {
        HStack(spacing: 14) {
            AppIcon(app: app, size: 64)
            VStack(alignment: .leading, spacing: 2) {
                Text(app.displayName).text(.xl, .bold).foregroundStyle(Theme.fg).lineLimit(2)
                Text([app.categoryName, app.stateName].filter { !$0.isEmpty }.joined(separator: " \u{00B7} ")).text(.base).foregroundStyle(Theme.fgMuted)
                if let note = app.sourceNote { Text(note).text(.sm).foregroundStyle(Theme.fgMuted) }
            }
            Spacer(minLength: 8)
            if app.isComingSoon {
                Text("Coming soon").text(.sm, .medium).foregroundStyle(Theme.fgSubtle)
            } else if app.isAdded {
                Button("Manage") { withAnimation { proxy.scrollTo("accounts", anchor: .top) } }
                    .buttonStyle(WebButton(variant: .secondary, size: .regular))
                    .accessibilityIdentifier("app-manage")
            } else {
                Button("Connect") { installer.start(app) }
                    .buttonStyle(WebButton(variant: .primary, size: .regular))
                    .disabled(!app.canAdd || installer.busy)
                    .accessibilityIdentifier("app-connect")
            }
        }
    }

    /// One line under the header when something needs attention: not set up here, a sign-in to renew, or an install being finished.
    private func notice(_ app: Contract.App) -> String? {
        if app.isComingSoon { return nil }
        if app.available == false && !app.isAdded { return "\(app.displayName) isn't set up on this server." }
        if app.needsSignIn { return "Sign in again to keep your agents using it." }
        return nil
    }

    // MARK: Try asking

    @ViewBuilder private func tryAsking(_ app: Contract.App) -> some View {
        if !app.prompts.isEmpty && !world.agents.isEmpty {
            PageSection("Try asking") {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(app.prompts, id: \.self) { prompt in
                            Button(prompt) { world.startChat(prompt, preferring: (app.enabledAgents ?? []).compactMap(\.agentId)) }
                                .buttonStyle(WebButton(variant: .secondary, size: .large))
                        }
                    }
                    .padding(.vertical, 2)
                }
                .scrollClipDisabled()
            }
        }
    }

    // MARK: Agents

    private func isOn(_ agent: Agent, in app: Contract.App) -> Bool {
        app.isChat ? app.accounts.contains { ($0.agents ?? []).contains { $0.agentId == agent.id } } : app.isEnabled(for: agent.id)
    }

    @ViewBuilder private func agentsRow(_ app: Contract.App) -> some View {
        if app.isAdded && !world.agents.isEmpty {
            PageSection(app.isChat ? "Agents in \(app.displayName)" : "Agents") {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: 18) {
                        ForEach(world.agents) { agent in
                            let on = isOn(agent, in: app)
                            Button { toggle(agent, in: app) } label: {
                                VStack(spacing: 4) {
                                    AvatarView(agent: agent, size: 50)
                                        .frame(width: 52, height: 52)
                                        .saturation(on ? 1 : 0.4)
                                        .overlay(alignment: .bottomTrailing) { badge(on: on) }
                                    Text(agent.name ?? "").text(.sm, .medium).foregroundStyle(Theme.fg).lineLimit(1)
                                }
                                .opacity(on ? 1 : 0.55)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("\(agent.name ?? "Agent"), \(on ? "on" : "off")")
                            .accessibilityIdentifier("app-agent-\(agent.id)")
                        }
                    }
                }
                if app.isChat && !app.accounts.contains(where: { $0.agentId == nil }) {
                    Text("These agents have their own bots. Manage them in each agent's settings.").text(.sm).foregroundStyle(Theme.fgSubtle)
                }
            }
        }
    }

    private func badge(on: Bool) -> some View {
        Image(systemName: on ? "checkmark" : "plus")
            .text(.xxs, .bold).foregroundStyle(on ? Color.white : Theme.primaryFg)
            .frame(width: 19, height: 19)
            .background(on ? Theme.success : Theme.primary, in: .circle)
            .overlay(Circle().strokeBorder(Theme.canvas, lineWidth: 2.5))
            .offset(x: 2, y: 0)
    }

    private func toggle(_ agent: Agent, in app: Contract.App) {
        if app.isChat {
            let shared = app.accounts.filter { $0.agentId == nil }
            if shared.count == 1, let only = shared.first {
                let on = (only.agents ?? []).contains { $0.agentId == agent.id }
                run { try await world.setWorkspaceAgent(app.id, installation: only.id, agent: agent.id, enabled: !on) }
            } else if shared.count > 1 {
                choosing = agent
            }
        } else {
            let on = app.isEnabled(for: agent.id)
            run { try await world.setAgentApp(agent.id, app.id, enabled: !on) }
        }
    }

    // MARK: What agents can do

    @ViewBuilder private func capabilities(_ detail: Contract.AppDetail?) -> some View {
        let list = detail?.capabilities ?? []
        if !list.isEmpty {
            PageSection("What agents can do") {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(showAllCapabilities ? list : Array(list.prefix(Self.cap)), id: \.name) { capability in
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(capability.title ?? capability.name ?? "").text(.md).foregroundStyle(Theme.fg).fixedSize(horizontal: false, vertical: true)
                                if capability.needsReview == true {
                                    Text("New").text(.xs, .medium).foregroundStyle(Theme.warning)
                                        .padding(.horizontal, 6).padding(.vertical, 2)
                                        .background(Theme.warning.opacity(0.15), in: .capsule)
                                }
                            }
                            Spacer(minLength: 8)
                            // A chat app has no Actions policy (grants.actions is false): its changes are marked, not "asked first".
                            if capability.kind == "change" { Text(detail?.grants?.actions == false ? "Changes" : "Asks first").text(.sm).foregroundStyle(Theme.warning) }
                            else { Text("Read").text(.sm).foregroundStyle(Theme.fgSubtle) }
                        }
                    }
                    ShowMore(shown: showAllCapabilities ? list.count : min(Self.cap, list.count), total: list.count) { withAnimation { showAllCapabilities = true } }
                    if list.contains(where: { $0.needsReview == true }) {
                        HStack(spacing: 12) {
                            Text("New or changed tools ask first, whatever the Actions setting says, until you mark them reviewed.")
                                .text(.xs).foregroundStyle(Theme.fgSubtle).fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 8)
                            Button("Mark reviewed") { run { try await world.reviewAppTools(detail?.id ?? appId) } }
                                .buttonStyle(WebButton(variant: .secondary, size: .xs))
                                .accessibilityIdentifier("app-mark-reviewed")
                        }
                    }
                }
            }
        }
    }

    // MARK: Actions policy

    /// One row per agent that may use the app: Ask first, Allow or Off for the tools that change things.
    @ViewBuilder private func actions(_ app: Contract.App) -> some View {
        let enabled = (app.enabledAgents ?? []).compactMap { entry in world.agent(entry.agentId).map { ($0, app.policy(for: $0.id)) } }
        if app.isPerAgent && app.isAdded && app.grants?.actions != false && !enabled.isEmpty {
            PageSection("Actions") {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(enabled, id: \.0.id) { agent, policy in
                        HStack(spacing: 10) {
                            AvatarView(agent: agent, size: AvatarSize.sm).frame(width: 28, height: 28)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(agent.name ?? "").text(.md).foregroundStyle(Theme.fg).lineLimit(1)
                                // The agent's one access state for this app, in the connect card's words.
                                let problem = ConnectCard.problem(app: app, agentId: agent.id, payload: nil)
                                Text(ConnectCard.note(for: problem, agent: agent.name ?? "this agent")).text(.xs)
                                    .foregroundStyle(problem == nil ? Theme.fgMuted : Theme.warning).lineLimit(1)
                            }
                            .frame(minWidth: 48, alignment: .leading)
                            Spacer(minLength: 4)
                            Picker("Actions for \(agent.name ?? "agent")", selection: Binding(get: { policy }, set: { new in
                                run { try await world.setAgentApp(agent.id, app.id, enabled: true, policy: new) }
                            })) {
                                Text("Ask first").tag(Contract.ActionsPolicy.ask)
                                Text("Allow").tag(Contract.ActionsPolicy.allow)
                                Text("Off").tag(Contract.ActionsPolicy.off)
                            }
                            .pickerStyle(.segmented)
                            .frame(maxWidth: 220)
                            .accessibilityIdentifier("app-policy-\(agent.id)")
                        }
                    }
                    Text("Ask first shows you an approval before anything is changed. Money, permanent deletion and secrets always ask.")
                        .text(.xs).foregroundStyle(Theme.fgSubtle).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    // MARK: Accounts and workspaces

    @ViewBuilder private func accounts(_ app: Contract.App, detail: Contract.AppDetail?) -> some View {
        let pending = (detail?.pending ?? []).filter { $0.status == "pending" }
        if app.isAdded || !pending.isEmpty || installer.waiting == app.id {
            PageSection(app.isChat ? "Workspaces" : "Accounts") {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(showAllAccounts ? app.accounts : Array(app.accounts.prefix(Self.cap))) { account in accountRow(account, app: app) }
                    ShowMore(shown: showAllAccounts ? app.accounts.count : min(Self.cap, app.accounts.count), total: app.accounts.count) { withAnimation { showAllAccounts = true } }
                    ForEach(pending) { item in pendingRow(item, app: app) }
                    if pending.isEmpty && installer.waiting == app.id {
                        HStack(spacing: 10) { ProgressView(); Text("Waiting for you to finish in \(app.displayName)\u{2026}").text(.base).foregroundStyle(Theme.fgMuted) }
                    }
                    if app.canAdd && app.isAdded {
                        Button(addAnotherTitle(app)) { installer.start(app) }
                            .buttonStyle(WebButton(variant: .secondary, size: .regular))
                            .disabled(installer.busy)
                            .accessibilityIdentifier("app-add-another")
                    }
                }
            }
        }
    }

    private func addAnotherTitle(_ app: Contract.App) -> String {
        switch app.categoryValue {
        case .chat: ChannelPlatform(kind: app.id) == .slack || ChannelPlatform(kind: app.id) == .discord ? "Add another workspace" : "Add another bot"
        default: "Add another account"
        }
    }

    private func accountRow(_ account: Contract.AppInstallation, app: Contract.App) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(account.label ?? app.displayName).text(.md, .medium).foregroundStyle(Theme.fg).lineLimit(1)
                accountStatus(account, app: app)
            }
            Spacer(minLength: 8)
            Menu {
                if app.isPerAgent { Button("Sign in again", systemImage: "arrow.clockwise") { installer.start(app, connectionId: account.id) } }
                Button("Remove", systemImage: "xmark.circle", role: .destructive) { removing = account }
            } label: {
                Image(systemName: "ellipsis").foregroundStyle(Theme.fgMuted).frame(width: 36, height: 36).contentShape(.rect)
            }
            .accessibilityLabel("Options for \(account.label ?? app.displayName)")
        }
        .accessibilityIdentifier("app-account-\(account.id)")
    }

    @ViewBuilder private func accountStatus(_ account: Contract.AppInstallation, app: Contract.App) -> some View {
        switch account.status {
        case "expired": Text("Sign in").text(.sm).foregroundStyle(Theme.warning)
        case "error" where app.isChat && account.agentId != nil:
            // A Slack or Discord bot made with the agent's own token: it comes back through the shared Juno app.
            Text("Reconnect through the shared app").text(.sm).foregroundStyle(Theme.warning)
        case "error": Text("Couldn't connect").text(.sm).foregroundStyle(Theme.warning)
        default:
            if app.isChat {
                let names = (account.agents ?? []).compactMap { world.agent($0.agentId)?.name }
                let own = account.agentId.flatMap { world.agent($0)?.name }
                Text(own.map { "\($0)'s own bot" } ?? (names.isEmpty ? "No agents yet" : names.joined(separator: ", "))).text(.sm).foregroundStyle(Theme.fgMuted).lineLimit(1)
            } else {
                Text("Connected").text(.sm).foregroundStyle(Theme.fgMuted)
            }
        }
    }

    private func pendingRow(_ item: Contract.AppPending, app: Contract.App) -> some View {
        HStack(spacing: 10) {
            ProgressView()
            Text("Waiting for you to finish\u{2026}").text(.base).foregroundStyle(Theme.fgMuted)
            Spacer(minLength: 8)
            if let link = item.openUrl.flatMap({ URL(string: $0) }) { Button("Open again") { openURL(link) }.buttonStyle(WebButton(variant: .secondary, size: .xs)) }
            Button("Cancel") { installer.stopWaiting(); run { try await world.removeInstallation(app.id, item.id) } }.buttonStyle(WebButton(variant: .ghost, size: .xs))
        }
    }

    // MARK: Information

    private func information(_ app: Contract.App) -> some View {
        PageSection("Information") {
            VStack(alignment: .leading, spacing: 8) {
                infoRow("Category", app.categoryName)
                infoRow("Made by", app.developerName)
                linkRow("Website", app.websiteUrl)
                linkRow("Privacy", app.privacyPolicyUrl)
                linkRow("Terms", app.termsOfServiceUrl)
            }
        }
    }

    @ViewBuilder private func infoRow(_ key: String, _ value: String?) -> some View {
        if let value, !value.isEmpty {
            HStack(alignment: .firstTextBaseline) {
                Text(key).text(.base).foregroundStyle(Theme.fgMuted)
                Spacer(minLength: 12)
                Text(value).text(.base).foregroundStyle(Theme.fg).multilineTextAlignment(.trailing)
            }
        }
    }

    @ViewBuilder private func linkRow(_ key: String, _ value: String?) -> some View {
        if let url = value.flatMap({ URL(string: $0) }), url.scheme == "https" || url.scheme == "http" {
            HStack(alignment: .firstTextBaseline) {
                Text(key).text(.base).foregroundStyle(Theme.fgMuted)
                Spacer(minLength: 12)
                Button { openURL(url) } label: { Text(url.host() ?? "Open").text(.base).foregroundStyle(Theme.fg).lineLimit(1) }
                    .buttonStyle(.plain)
            }
        }
    }

    private func run(_ work: @escaping () async throws -> Void) {
        failure = nil
        Task { @MainActor in
            do { try await work() } catch where !error.isCancellation { failure = error.localizedDescription } catch {}
        }
    }
}
