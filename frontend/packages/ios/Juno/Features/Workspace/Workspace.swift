import SwiftUI

/// The web's right-pane workspace (features/agents/pane/AgentPane.tsx) as a sheet: two sections, Computer | Files.
/// The top bar says whose computer this is; tapping it opens that agent's page (management lives there, not here).
struct WorkspaceView: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var conversationId: String
    @State var agentId: String
    /// `-section files` on launch picks the first section (Simulator screenshots).
    @State private var section = Section.allCases.first { "\($0)" == UserDefaults.standard.string(forKey: "section") } ?? .computer

    enum Section: String, CaseIterable, Identifiable {
        case computer = "Computer", files = "Files"
        var id: String { rawValue }
    }

    var body: some View {
        let agent = world.agent(agentId)
        let members = (world.conversation(conversationId)?.agentIds ?? []).compactMap(world.agent)
        NavigationStack {
            Group {
                switch section {
                case .computer: ComputerPanel(agentId: agentId)
                case .files: FilesTab(conversationId: conversationId)
                }
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                Picker("Section", selection: $section) {
                    ForEach(Section.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal).padding(.bottom, 8)
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackgroundVisibility(.hidden, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Button { world.openAgentPage(agentId, from: "workspace-\(agentId)") } label: {
                        // Name and status only: the chat header above already shows the avatar.
                        VStack(spacing: 0) {
                            Text(agent?.name ?? "Agent").text(.sm, .semibold).foregroundStyle(Theme.fg).lineLimit(1)
                            Text(agent?.status.map(Fmt.status) ?? "").text(.xs).foregroundStyle(Theme.fgMuted).lineLimit(1)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(agent?.name ?? "Agent") page")
                }
                .sharedBackgroundVisibility(.hidden)
                if members.count > 1 {
                    ToolbarItem(placement: .topBarLeading) {
                        Menu("Agent", systemImage: "person.2") {
                            Picker("Agent", selection: $agentId) {
                                ForEach(members) { Text($0.name ?? "").tag($0.id) }
                            }
                        }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
            }
            .junoDestinations()
        }
        .presentationDetents([.large])
    }
}

// MARK: - Computer

/// Screen + "Needs you" banner + control bar (ComputerPane/ControlBanner). The prototype has no VNC stream,
/// so the frame shows the agent's latest step at the computer's aspect ratio.
struct ComputerPanel: View {
    @Environment(World.self) private var world
    var agentId: String
    @State private var fullScreen = false
    @State private var takingOver = false

    var body: some View {
        let agent = world.agent(agentId)
        let waiting = world.pending(of: agentId).first { $0.kind == "approval" || $0.kind == "question" }
        let user = world.computer?.controller == "user"
        ScrollView {
            VStack(spacing: 12) {
                if let waiting { NeedsYouBanner(agentName: agent?.name ?? "", request: waiting) }
                ScreenFrame(agentId: agentId)
                    .onTapGesture { fullScreen = true }
                WorkspaceTasks(agentId: agentId)
            }
            .padding()
        }
        .toolbar {
            if !(world.api != nil && world.computers.isEmpty) {
            ToolbarItem(placement: .bottomBar) {
                Text(user ? "You have control" : "\(agent?.name ?? "") has control").fixedSize()
            }
            ToolbarSpacer(.flexible, placement: .bottomBar)
            ToolbarItem(placement: .bottomBar) {
                // One take-over experience everywhere: the full-screen TakeoverView (keyboard, copy/paste, pointer).
                Button(user ? "Return to agent" : "Take over") {
                    if user { withAnimation { world.setController("agent", agentId: agentId) } } else { takingOver = true }
                }
                // Nothing to take over until the agent has a display.
                .disabled(!user && world.api != nil && !world.hasScreen(agentId))
            }
            ToolbarItem(placement: .bottomBar) {
                Button("Full screen", systemImage: "arrow.up.left.and.arrow.down.right") { fullScreen = true }
            }
            }
        }
        .fullScreenCover(isPresented: $fullScreen) { FullScreenComputer(agentId: agentId) }
        .fullScreenCover(isPresented: $takingOver) { TakeoverView(agentId: agentId) }
    }
}

/// The screen itself. Placeholder content (the step being done) until a live stream exists.
struct ScreenFrame: View {
    @Environment(World.self) private var world
    var agentId: String
    /// A transcript card needs its final size on first render: it fixes the aspect instead of waiting for the
    /// first screenshot to say what the real screen's is.
    var fixedAspect: CGFloat?
    @State private var liveURL: URL?
    @State private var connected = false
    /// True only while a stream ticket is being fetched; a nil URL after that means no display / no ticket.
    @State private var dialing = false
    @State private var starting = false
    @State private var startError: String?

    /// Primary Start action for the empty states (web ScreenPlaceholder onStart): spinner while pending, the server's message on failure.
    private func startButton(_ title: String, pending: String) -> some View {
        VStack(spacing: 8) {
            Button {
                starting = true
                startError = nil
                Task {
                    startError = await world.startComputer(for: agentId)
                    starting = false
                }
            } label: {
                HStack(spacing: 6) {
                    if starting { ProgressView().controlSize(.small) }
                    Text(starting ? pending : title)
                }
            }
            .buttonStyle(WebButton(variant: .primary))
            .disabled(starting)
            if let startError {
                Text(startError).text(.xs).foregroundStyle(Theme.danger).multilineTextAlignment(.center)
            }
        }
    }

    var body: some View {
        let run = world.activeRuns(of: agentId).first
        let step = run?.steps?.last
        let userControl = world.computer?.controller == "user"
        ZStack {
            Color.black.opacity(0.88)
            Group {
                if let shot = world.screenshots[agentId] {
                    Image(uiImage: shot).resizable().scaledToFit()
                } else if world.api != nil && world.computers.isEmpty {
                    // Live account without a computer (web ComputerPane "Set up computer" state).
                    ContentUnavailableView {
                        Label("No computer yet", systemImage: "desktopcomputer")
                    } description: {
                        Text("Set up a computer for this workspace to let \(world.agent(agentId)?.name ?? "this agent") use it.")
                    } actions: {
                        startButton("Set up computer", pending: "Setting up the computer…")
                    }
                } else if world.computer?.state == "asleep" {
                    ContentUnavailableView("The computer is asleep", systemImage: "moon.zzz", description: Text("It wakes when it's needed."))
                } else if world.api != nil && (dialing || liveURL != nil && !connected) {
                    // Live server, (re)connecting: a quiet spinner, not a step caption flashing between frames.
                    ProgressView().tint(.white)
                } else if let step {
                    ContentUnavailableView(step.verb ?? "", systemImage: step.kind == "shell" ? "terminal" : "globe", description: Text(step.target ?? ""))
                } else {
                    ContentUnavailableView {
                        Label("No screen yet", systemImage: "display")
                    } description: {
                        Text("\(world.agent(agentId)?.name ?? "This agent") opens one the first time it uses the computer, or you can start it now.")
                    } actions: {
                        startButton("Start screen", pending: "Starting screen…")
                    }
                }
            }
            .environment(\.colorScheme, .dark)
            // Live video (noVNC) over the screenshot; the screenshot stays underneath until the first frame.
            if let liveURL {
                LiveScreen(url: liveURL, viewOnly: !userControl) { state in
                    switch state {
                    case "connected":
                        connected = true
                        // Keep a recent still, so a re-dial (take over / hand back) fades from the last picture.
                        Task { await world.refreshScreen(agentId) }
                    default: connected = false; self.liveURL = nil  // dropped/expired ticket → dial a fresh one
                    }
                }
                .opacity(connected ? 1 : 0)
                .allowsHitTesting(userControl)
            }
        }
        // The real screen's aspect (e.g. 1280×800) once a screenshot has arrived; the web fallback 1364×1024 before.
        .aspectRatio(fixedAspect ?? world.screenshots[agentId].map { $0.size.width / max($0.size.height, 1) } ?? 1364.0 / 1024.0, contentMode: .fit)
        // Live servers: a signed stream ticket for the current control mode; screenshots every 3s until it connects.
        .task(id: "\(agentId)-\(userControl)-\(liveURL == nil)") {
            if liveURL == nil, world.api != nil {
                connected = false
                dialing = true
                liveURL = await world.streamURL(agentId, control: userControl)
                dialing = false
            }
            while !Task.isCancelled && !connected {
                // No display yet: the agent creates one on its first computer action, so keep asking.
                if liveURL == nil, world.api != nil { liveURL = await world.streamURL(agentId, control: userControl) }
                await world.refreshScreen(agentId)
                try? await Task.sleep(for: .seconds(3))
            }
        }
        .onChange(of: userControl) { liveURL = nil }
        .clipShape(.rect(cornerRadius: Radius.screen))
        .overlay(RoundedRectangle(cornerRadius: Radius.screen).stroke(userControl ? (agentTint(world.agent(agentId))) : Theme.border, lineWidth: userControl ? 5 : 1))
    }
}

/// ControlBanner.tsx needs-you mode: muted surface, 16pt icon, title + xs subtitle, sm pill actions.
struct NeedsYouBanner: View {
    @Environment(World.self) private var world
    var agentName: String
    var request: AgentRequest

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                Circle().fill(Theme.warning).frame(width: 6, height: 6).padding(.top, 6)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Needs you").text(.sm, .medium).foregroundStyle(Theme.fg)
                    Text("\(agentName) is waiting for you before it continues.").text(.xs).foregroundStyle(Theme.fgMuted)
                }
            }
            HStack(spacing: 6) {
                Spacer()
                Button("Skip this step") { world.resolve(request.id, decision: "denied") }.buttonStyle(WebButton(variant: .ghost))
                Button("I'm done, continue") { world.resolve(request.id, decision: "approved") }.buttonStyle(WebButton(variant: .primary))
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Theme.muted, in: .rect(cornerRadius: Radius.xl))
    }
}

/// Full-screen computer: the one screen that may turn landscape (bigger picture). Control lives in the bottom toolbar.
struct FullScreenComputer: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var agentId: String
    @State private var takingOver = false

    var body: some View {
        let user = world.computer?.controller == "user"
        NavigationStack {
            ScreenFrame(agentId: agentId)
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.black)
                .allowsLandscape()
                .navigationTitle(world.agent(agentId)?.name ?? "Computer")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) { Button("Close", systemImage: "xmark") { dismiss() } }
                    ToolbarItem(placement: .bottomBar) {
                        Text(user ? "You have control" : "\(world.agent(agentId)?.name ?? "") has control")
                    }
                    ToolbarSpacer(.flexible, placement: .bottomBar)
                    ToolbarItem(placement: .bottomBar) {
                        Button(user ? "Return to agent" : "Take over") {
                            if user { world.setController("agent", agentId: agentId) } else { takingOver = true }
                        }
                        .disabled(!user && world.api != nil && !world.hasScreen(agentId))
                    }
                }
        }
        .environment(\.colorScheme, .dark)
        .fullScreenCover(isPresented: $takingOver) { TakeoverView(agentId: agentId) }
    }
}

// MARK: - Needs you

/// Every pending request (or one agent's), newest first; each opens its full detail with the decision buttons.
struct NeedsYouList: View {
    @Environment(World.self) private var world
    var agentId: String? = nil

    var body: some View {
        let requests = agentId.map(world.pending(of:)) ?? world.pending
        Group {
            if requests.isEmpty {
                ContentUnavailableView("Nothing is waiting on you", systemImage: "checkmark.circle")
            } else {
                List(requests) { r in
                    RouteLink(route: .request(r.id)) {
                        Label {
                            Text(r.sentence)
                            Text("\(world.agent(r.agentId)?.name ?? "") · \(Fmt.requestTitle(r.kind)) · \(Fmt.ago(r.createdAt))")
                        } icon: { Image(systemName: requestIcon(r)).foregroundStyle(.orange) }
                    }
                }
                .webGrouped().listRowBackground(Theme.muted)
            }
        }
        .pageHeader("Needs you")
    }
}

// MARK: - Files

struct FilesTab: View {
    @Environment(World.self) private var world
    var conversationId: String
    var body: some View {
        let files = world.files(in: conversationId)
        if files.isEmpty {
            ContentUnavailableView("No files in this chat yet", systemImage: "doc")
        } else {
            List(files) { FileRow(file: $0) }.webGrouped().listRowBackground(Theme.muted)
        }
    }
}
