import SwiftUI

/// Five system tabs, Muse's: Chat (with the Today header), Feed, Ideas, Goals, Library; settings live in the drawer.
/// Sheets are global (`world.sheet`). The top-level tabs share one agent picker in the header.
struct RootView: View {
    @Environment(World.self) private var world
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.scenePhase) private var scenePhase
    @State private var restoring = SessionStore.load() != nil
    /// First launch only: onboarding before the login screen (see OnboardingGate).
    @State private var onboarding = OnboardingGate.shouldShow

    var body: some View {
        content
            // A model was chosen on the "Connect a model" screen: continue into the default agent's chat.
            .onChange(of: world.modelProviders?.usable) { old, new in
                if old == false, new == true { world.openChat(world.defaultDirectChat?.id) }
            }
    }

    @ViewBuilder private var content: some View {
        if world.session == nil && !restoring {
            // Keyboard avoidance has to be off at the root too, or the whole login screen still lifts.
            if onboarding {
                OnboardingView { OnboardingGate.markSeen(); withAnimation(.easeInOut(duration: 0.3)) { onboarding = false } }
                    .transition(.opacity)
            } else {
                LoginView()
            }
        } else if restoring {
            // Signed in on a previous launch: a quiet blank canvas until the account's first load completes.
            Theme.canvas.ignoresSafeArea().task {
                guard let session = SessionStore.load() else { restoring = false; return }
                // The device's copy first: the app is up with the chats as they were, then the network catches up.
                world.restore(session, present: true)
                restoring = false
                // Not tied to this view: it goes away as soon as `restoring` flips, which would cancel the requests.
                Task { @MainActor in
                    do { try await world.connect(session); await openFirstChatIfOnboarding() } catch {
                        // Only a refused login ends the session; being offline keeps the stored chats readable.
                        if case APIError.api(let status, _, _) = error, status == 401 { world.signOut() }
                        else if case APIError.http(let status, _) = error, status == 401 { world.signOut() }
                        else {
                            if !error.isCancellation { world.syncError = error.localizedDescription }
                            world.startStream(session, after: world.store?.cursor())
                        }
                    }
                }
            }
        } else if world.modelProviders?.usable == false {
            ConnectModelView()
        } else {
            tabs
            .task(id: "\(scenePhase == .active && world.api != nil)") {
                world.appActive = scenePhase == .active
                PhoneDevice.shared.appActive(scenePhase == .active)
                if scenePhase == .active {
                    world.streamGraceUntil = Date().addingTimeInterval(World.reconnectGrace)
                    // Back in the app with a chat open: what arrived meanwhile is read.
                    if let open = world.currentConversationId { world.markConversationRead(open) }
                    await world.refreshAgents()
                    await world.reportTimeZone()
                    await world.refreshModelProviders()
                }
            }
            .alert("Couldn't reach the server", isPresented: Binding(get: { world.syncError != nil }, set: { if !$0 { world.syncError = nil } })) {
                Button("OK") { world.syncError = nil }
            } message: { Text(world.syncError ?? "") }
        }
    }

    /// Still in the first conversation (the default agent's chat, at most 3 messages from the user): the app opens that
    /// chat, not Home. Runs once the conversation list has loaded; any other account opens as before.
    private func openFirstChatIfOnboarding() async {
        let count = world.conversations.count
        guard world.currentConversationId == nil, count == 1, let chat = world.conversations.first, chat.kind == "direct" else {
            #if DEBUG
            print("[first-chat] skip: open=\(world.currentConversationId ?? "-") conversations=\(count)")
            #endif
            return
        }
        if world.items[chat.id] == nil { await world.fetchNewest(chat.id) }
        let users = (world.items[chat.id] ?? []).filter { $0.type == "user_message" }.count
        #if DEBUG
        print("[first-chat] userMessages=\(users) -> \(users <= 3 ? "open" : "home")")
        #endif
        if users <= 3 { world.openChat(chat.id) }
    }

    private var tabs: some View {
        @Bindable var world = world
        // Muse's structure: tabs pick what to look at, the ☰ sidebar picks who to talk to (agents, recents),
        // new chat and settings. The page slides right to reveal the sidebar (ChatGPT); `DrawerController` runs
        // the slide and the swipe natively.
        // All safe areas, the keyboard's too: the UIKit shell stays full screen and each hosted page lifts its own
        // composer; avoiding the keyboard here shrank the whole shell (sidebar showing through, chat squashed).
        return DrawerShell()
            .ignoresSafeArea(.all, edges: .all)
            .background(Theme.canvas)
        // No .tabBarMinimizeBehavior(.onScrollDown): with the chat hiding the tab bar, scrolling a chat opened from
        // another tab left the toolbar re-laying out forever (app never idle, ~35% CPU).
        .sheet(item: $world.sheet) { SheetHost(route: $0) }
        .onAppear(perform: applyLaunchArguments)
    }

    /// Simulator screenshots: `-tab feed`, `-open conv-juno`, `-sheet card|workspace|queue|takeover`,
    /// `-section computer|needs|…`, `-profile activity|approvals|computer|schedules|memory`, `-page files|routines|…`,
    /// `-draft "…"`, `-say "…"`, `-create-goal YES`.
    private func applyLaunchArguments() {
        let d = UserDefaults.standard
        if let open = d.string(forKey: "open"), !open.isEmpty { world.openChat(open, draft: d.string(forKey: "draft").flatMap { $0.isEmpty ? nil : $0 }) }
        if let tab = d.string(forKey: "tab"), !tab.isEmpty { world.tab = ["files", "more", "home"].contains(tab) ? (tab == "home" ? "chat" : "library") : tab }
        if d.string(forKey: "sheet") == "queue" { world.sheet = .queue }
        if let id = d.string(forKey: "request-sheet"), !id.isEmpty { world.sheet = world.request(id)?.kind == "question" ? .question(id) : .secureInput(id) }
        if d.bool(forKey: "sidebar") { world.sidebarOpen = true }
        // `-say "…"` sends a message in the opened chat (screenshots of your own bubble).
        if let say = d.string(forKey: "say"), !say.isEmpty, let c = world.currentConversationId { world.send(say, in: c) }
    }
}

// MARK: - Agent picker (the header of every top-level tab; replaces the old filter menu)

/// Centred figure in the nav bar: stacked figures for "All", one figure when an agent is picked. Tap → agent list.
struct AgentScopeButton: View {
    @Environment(World.self) private var world
    @State private var choosing = false
    /// In a nav bar the system draws the glass capsule around the item: just the figure(s), no name or chevron of our own.
    var compact = false

    var body: some View {
        let agent = world.agent(world.scope)
        Button { choosing = true } label: {
            if compact {
                Group {
                    if let agent { AvatarView(agent: agent, size: AvatarSize.md) }
                    else { StackedFigures(agents: Array(world.agents.prefix(3)), size: AvatarSize.md) }
                }
                .contentShape(.rect)
            } else {
            HStack(spacing: 6) {
                if let agent {
                    AvatarView(agent: agent, size: AvatarSize.md)
                } else {
                    StackedFigures(agents: Array(world.agents.prefix(3)), size: AvatarSize.md)
                }
                Text(agent?.name ?? "All agents").text(.base, .medium)
                    .lineLimit(1).foregroundStyle(Theme.fg)
                Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Theme.fgMuted)
            }
            .padding(.horizontal, 10)
            .frame(height: 44)
            .glassEffect(.regular, in: .capsule)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Agent: \(agent?.name ?? "All agents")")
        .sheet(isPresented: $choosing) { AgentPickerSheet().junoSheetPresentation(long: true) }
    }
}

/// Overlapping figures, the web's avatar group.
struct StackedFigures: View {
    var agents: [Agent]
    var size: CGFloat
    var body: some View {
        HStack(spacing: -size * 0.35) {
            // No disc behind each figure: the mascot isn't round, so a circle around it looked odd.
            ForEach(agents) { AvatarView(agent: $0, size: size * 0.8) }
        }
        .frame(height: size)
    }
}

/// Every agent, plus "All". Picking one sets `world.scope` for every top-level tab at once.
struct AgentPickerSheet: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Button { world.scope = nil; dismiss() } label: {
                    HStack {
                        StackedFigures(agents: Array(world.agents.prefix(3)), size: AvatarSize.md)
                        Text("All agents").font(.headline)
                        Spacer()
                        if world.scope == nil { Image(systemName: "checkmark").foregroundStyle(Theme.fg) }
                    }
                }
                .foregroundStyle(Theme.fg)
                .listRowBackground(Theme.muted)
                Section("Agents") {
                    ForEach(world.agents) { a in
                        Button { world.scope = a.id; dismiss() } label: {
                            HStack {
                                AgentRow(agent: a, title: a.name ?? "", subtitle: subtitle(a))
                                if world.scope == a.id { Image(systemName: "checkmark").foregroundStyle(Theme.fg) }
                            }
                        }
                        .foregroundStyle(Theme.fg)
                        .listRowBackground(Theme.muted)
                        .accessibilityIdentifier("agent-scope-\(a.id)")
                    }
                }
            }
            .webGrouped()
            .pageHeader("Agents")
            .toolbar { CloseButton() }
        }
    }

    /// What the agent is for (its role), else what it is doing.
    private func subtitle(_ a: Agent) -> String {
        if let role = world.role(a) { return role }
        return world.doingLine(a)
    }
}

// MARK: - More: agents, files and the global pages

struct MorePage: View {
    @Environment(World.self) private var world
    @State private var path: [Route] = []
    /// A page to open on appear (an unlock card).
    var link: SettingsLink?
    @State private var opened: SettingsLink?
    @State private var consumed = false
    @State private var addingWatch = false

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Group {
                Section("Agents") {
                    ForEach(world.agents) { a in
                        RouteLink(route: .agent(a.id)) {
                            AgentRow(agent: a, title: a.name ?? "", subtitle: world.doingLine(a))
                        }
                    }
                }
                AccountSection()
                if world.api != nil {
                    Section {
                        NavigationLink { AboutMeView() } label: { Label("About you", systemImage: "person.text.rectangle") }
                        NavigationLink { ProfileView() } label: { Label("Your details", systemImage: "person.crop.rectangle") }
                        NavigationLink { PhoneAccessView() } label: { Label("Calendar and reminders", systemImage: "calendar") }
                        NavigationLink { ProactiveRulesView() } label: { Label("What's worth interrupting me for", systemImage: "bell.badge") }
                        Button { addingWatch = true } label: { Label("Add Apple Watch", systemImage: "applewatch") }
                            .foregroundStyle(Theme.fg)
                            .accessibilityIdentifier("settings-add-watch")
                    }
                    Section("Agents run on") {
                        NavigationLink { ModelSettingsView() } label: { Label("Models", systemImage: "cpu") }
                    }
                }
                Section("Workspace") {
                    ForEach(GlobalPage.allCases.filter { $0 != .library && $0 != .skills }) { page in
                        RouteLink(route: .page(page)) { Label(page.rawValue, systemImage: page.icon) }
                    }
                }
                }
                .listRowBackground(Theme.muted)
            }
            .webGrouped()
            .pageHeader("Settings")
            // Inline: the system places a large title at its own inset, off the sheet's 24pt rows.
            .toolbar { CloseButton() }
            .junoDestinations()
            .navigationDestination(item: $opened) { link in
                switch link {
                case .details: ProfileView()
                }
            }
            .sheet(isPresented: $addingWatch) { AddWatchSheet() }
        }
        .onAppear {
            if !consumed, let link { consumed = true; opened = link }
            // `-page files` (screenshots): open a global page directly.
            if let key = UserDefaults.standard.string(forKey: "page"),
               let page = GlobalPage.allCases.first(where: { $0.rawValue.lowercased() == key.lowercased() }) {
                path = [.page(page)]
                UserDefaults.standard.removeObject(forKey: "page")
            }
        }
    }
}
