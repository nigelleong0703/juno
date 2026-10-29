import SwiftUI

/// Navigation targets pushed inside a NavigationStack / split-view detail.
enum Route: Hashable {
    case run(String)
    case agent(String)
    case page(GlobalPage)
    case request(String)
    case goal(String)
    case chat(String)
    /// The Apps page, and one app's page (contracts 0.65.0; replaces Plugins › Connectors).
    case apps
    case app(String)
    /// The full Feed, Ideas and the goals list: no longer tabs (owner-approved 2026-10-26), pushed from Today and Team.
    case feed
    case ideas
    case goalList
    /// Team: Memory's search and review queue, one person and the possible matches (their data is in `World.teamMemory` /
    /// `World.teamPeople`). A remembered item has no page: its phrase in the prose opens a sheet.
    case memorySearch
    case memoryReview
    case person(String)
    case peopleMatches
}

enum GlobalPage: String, CaseIterable, Hashable, Identifiable {
    case routines = "Routines", rules = "Rules", skills = "Skills", memory = "Memory", library = "Library", usage = "Usage"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .routines: "arrow.triangle.2.circlepath"
        case .rules: "checkmark.shield"
        case .skills: "sparkles"
        case .memory: "brain"
        case .library: "doc.text"
        case .usage: "chart.bar"
        }
    }
}

/// The agent page opens as a full-screen cover that zooms out of the avatar it was opened from.
/// `sourceId` names that avatar (`.agentZoomSource`); with no such view on screen it falls back to the cover animation.
struct AgentPageTarget: Identifiable, Hashable {
    var agentId: String
    var sourceId: String
    /// The profile tab to open on (`AgentProfileView.ProfileTab` raw value), nil for the default.
    var tab: String?
    var id: String { "\(agentId)|\(sourceId)" }
}

/// Where each on-screen avatar lives, by zoom-source id ("home-<id>", "chat-<id>", "list-<id>"). The native zoom
/// transition (JunoTabBarController) reads the view back when the agent page opens; a gone view means no zoom.
@MainActor
enum AgentZoomSources {
    private static var views: [String: [Weak]] = [:]
    private struct Weak { weak var view: UIView? }
    /// An id can have several views alive at once (UIKit keeps a second copy of a navigation-bar item while it
    /// transitions); the latest registration must not hide the one that is actually on screen.
    static func register(_ id: String, _ view: UIView) {
        var list = (views[id] ?? []).filter { $0.view != nil && $0.view !== view }
        list.append(Weak(view: view))
        views[id] = list
    }
    /// The newest registered view of this id that is in a window.
    static func view(for id: String) -> UIView? {
        views[id]?.reversed().compactMap(\.view).first { $0.window != nil }
    }
}

/// A transparent UIView laid over the avatar so UIKit can use its frame as the zoom's source.
private struct ZoomAnchor: UIViewRepresentable {
    var id: String
    func makeUIView(context: Context) -> UIView {
        let v = UIView()
        v.isUserInteractionEnabled = false
        v.layer.cornerRadius = 22
        v.layer.cornerCurve = .continuous
        return v
    }
    func updateUIView(_ view: UIView, context: Context) { AgentZoomSources.register(id, view) }
}

extension View {
    /// Marks this avatar as the origin of the agent page's zoom (ids are unique per agent and place: "home-<id>").
    func agentZoomSource(_ id: String) -> some View { background { ZoomAnchor(id: id) } }
}

/// Sheets that can be opened from anywhere (workspace, the Needs-you queue, Settings → Models). They are presented
/// from the root, so they never inherit a caller's styling and survive the caller re-rendering or going away.
/// A Settings page to open straight away (an unlock card's button): Your details.
enum SettingsLink: Hashable {
    case details
}

enum SheetRoute: Identifiable, Hashable {
    case workspace(conversationId: String, agentId: String)
    case queue
    case newAgent
    case models
    case secureInput(String)
    case question(String)
    case runSteps(String)
    case settings(SettingsLink)
    var id: String {
        switch self {
        case .workspace(let c, let a): "ws-\(c)-\(a)"
        case .queue: "queue"
        case .newAgent: "new-agent"
        case .models: "models"
        case .secureInput(let id): "secure-\(id)"
        case .question(let id): "question-\(id)"
        case .runSteps(let id): "steps-\(id)"
        case .settings: "settings"
        }
    }
}

/// Resolves a SheetRoute into its view; the root presents `world.sheet` with this.
struct SheetHost: View {
    var route: SheetRoute
    var body: some View {
        switch route {
        case .workspace(let c, let a): WorkspaceView(conversationId: c, agentId: a)
        case .queue: NavigationStack { NeedsYouList().junoDestinations().toolbar { CloseButton() } }.junoSheetPresentation(long: true)
        case .newAgent: NewAgentSheet()
        case .models: NavigationStack { ModelSettingsView().toolbar { CloseButton() } }.tint(Theme.fg).junoSheetPresentation(long: true)
        case .secureInput(let id): SecureInputSheet(requestId: id)
        case .question(let id): QuestionSheet(requestId: id)
        case .runSteps(let id): TaskCard(runId: id).junoSheetPresentation(long: true)
        case .settings(let link): MorePage(link: link).junoSheetPresentation(long: true)
        }
    }
}

/// The system close button for sheets.
struct CloseButton: ToolbarContent {
    @Environment(\.dismiss) private var dismiss
    var identifier = "Close"
    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) { Button("Close", systemImage: "xmark") { dismiss() }.accessibilityIdentifier(identifier) }
    }
}

extension View {
    /// Registers every Route destination; attach once per NavigationStack root.
    func junoDestinations() -> some View {
        navigationDestination(for: Route.self) { RouteDestination(route: $0) }
    }
}

struct RouteDestination: View {
    var route: Route
    var body: some View {
        switch route {
        case .run(let id): RunDetailView(runId: id)
        case .agent(let id): AgentProfileView(agentId: id)
        case .goal(let id): GoalDetailView(goalId: id)
        case .goalList: GoalsPage()
        case .feed: FeedPage()
        case .ideas: IdeasPage()
        case .memorySearch: MemorySearchPage()
        case .memoryReview: MemoryReviewPage()
        case .person(let id): PersonDetailPage(personId: id)
        case .peopleMatches: PeopleMatchesPage()
        case .page(let page):
            if page == .routines { RoutinesHome() } else { GlobalPageView(page: page) }
        case .apps: AppsPage()
        case .app(let id): AppDetailPage(appId: id)
        case .request(let id): RequestDetail(requestId: id)
        case .chat(let id): ConversationView(conversationId: id).id(id).toolbar(.hidden, for: .tabBar)
        }
    }
}

extension EnvironmentValues {
    /// Set by a screen whose rows live outside its NavigationStack (the chat list's cells are hosted by UIKit, so a
    /// NavigationLink there has no stack and draws as a list row with a chevron). Nil: rows use NavigationLink.
    @Entry var openRoute: ((Route) -> Void)? = nil
    /// Set by the tab's `PageNavigationController`: goes back one page (a pushed hosting controller cannot `dismiss`).
    @Entry var popPage: (() -> Void)? = nil
}

extension EnvironmentValues {
    /// Set by the Chats tab's UINavigationController: pushes a route onto it as a hosted RouteDestination.
    @Entry var pushRoute: ((Route) -> Void)? = nil
    /// Set by `ChatHostingController`: it hosts the composer and jump button itself (on the keyboard layout guide),
    /// so `ConversationView` does not draw them.
    @Entry var composerHosted = false
}

/// A push to `route`: a NavigationLink in a normal stack, a plain Button where `openRoute` is provided.
struct RouteLink<Label: View>: View {
    @Environment(\.openRoute) private var openRoute
    var route: Route
    @ViewBuilder var label: Label
    var body: some View {
        if let openRoute {
            Button { openRoute(route) } label: { label }
        } else {
            NavigationLink(value: route) { label }
        }
    }
}

/// `LabeledContent` that disappears when the value is empty (mock payloads are sparse).
@ViewBuilder func info(_ key: String, _ value: String?) -> some View {
    if let value, !value.isEmpty { LabeledContent(key, value: value) }
}

// MARK: - Formatting

enum Fmt {
    static func ago(_ date: Date?) -> String {
        guard let date else { return "" }
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f.localizedString(for: date, relativeTo: Date())
    }

    static func time(_ date: Date?) -> String {
        guard let date else { return "" }
        return date.formatted(date: .omitted, time: .shortened)
    }

    static func duration(_ ms: Int?) -> String {
        guard let ms else { return "" }
        let s = ms / 1000
        if s < 60 { return "\(max(s, 1))s" }
        if s < 3600 { return "\(s / 60)m" }
        return "\(s / 3600)h \(s % 3600 / 60)m"
    }

    static func bytes(_ n: Int?) -> String {
        guard let n else { return "" }
        return ByteCountFormatter.string(fromByteCount: Int64(n), countStyle: .file)
    }

    /// The one status vocabulary, shared by agents and runs (StatusDot, StatusChip, headers, rows).
    static func status(_ s: String?) -> String {
        switch s {
        case "working": "Working"
        case "running": "Running"
        case "queued": "Queued"
        case "scheduled": "Scheduled"
        case "needs_you": "Needs you"
        case "waiting_for_input": "Waiting for you"
        case "blocked": "Blocked"
        case "completed": "Completed"
        case "failed": "Failed"
        case "stopped": "Stopped"
        case "sleeping": "Sleeping"
        case "error": "Error"
        case nil, "idle": "Idle"
        default: s?.replacingOccurrences(of: "_", with: " ").capitalized ?? "Idle"
        }
    }

    /// A run's error in words: model-service failures (402 credit, 401 key, 429 rate) say what to do; anything
    /// else keeps its first line without the JSON body. The run detail page still shows the raw text.
    static func runError(_ raw: String) -> String {
        if raw.contains("(402)") || raw.localizedCaseInsensitiveContains("insufficient") {
            return "The model service is out of credit. Pick another model in Settings or top it up."
        }
        if raw.contains("(401)") || raw.contains("(403)") { return "The model service rejected the key. Check the model settings." }
        if raw.contains("(429)") { return "The model service is busy (rate limited). Try again in a moment." }
        let line = raw.split(separator: "\n").first.map(String.init) ?? raw
        return line.split(separator: "{").first.map { $0.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: ":")) } ?? line
    }

    static func requestTitle(_ kind: String?) -> String {
        switch kind {
        case "question": "Question"
        case "signin": "Sign-in needed"
        case "admin": "Access request"
        case "computer": "Take over"
        case "secure_input": "Secure input"
        case "connect": "Connect an app"
        default: "Approval needed"
        }
    }
}

/// Colour reserved for state, from one table: success (working / running / completed), warning (needs you /
/// waiting / blocked), danger (error / failed), neutral otherwise.
enum StatusTone {
    case success, warning, danger, neutral

    init(_ status: String?) {
        switch status {
        case "working", "running", "completed": self = .success
        case "needs_you", "waiting_for_input", "blocked": self = .warning
        case "error", "failed": self = .danger
        default: self = .neutral
        }
    }

    var color: Color {
        switch self {
        case .success: Theme.success
        case .warning: Theme.warning
        case .danger: Theme.danger
        case .neutral: .secondary
        }
    }
}

/// Status as a coloured dot (colour is reserved for state, as on the web).
struct StatusDot: View {
    var status: String?
    var size: CGFloat = 8
    var body: some View {
        Circle().fill(StatusTone(status).color).frame(width: size, height: size)
    }
}

/// An agent's dot on its avatar, as the web draws it (AgentAvatar.tsx `showDot`): green only while working, amber
/// when it needs you, and no dot at all for idle, sleeping, paused or unknown.
struct AgentDot: View {
    var status: String?
    var needsYou: Bool
    var size: CGFloat = 8

    static func shows(_ status: String?, needsYou: Bool) -> Bool { needsYou || status == "working" }

    var body: some View {
        StatusDot(status: needsYou ? "needs_you" : "working", size: size)
    }
}

/// The web StatusPill: a dot and a word on a neutral capsule. The one status chip.
struct StatusChip: View {
    var status: String?
    var body: some View {
        HStack(spacing: 5) {
            StatusDot(status: status)
            Text(Fmt.status(status)).text(.xs, .medium).foregroundStyle(Theme.fgMuted).lineLimit(1)
        }
        .fixedSize()
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(Theme.muted, in: .capsule)
    }
}

/// Avatar + title + secondary line, laid out like a Mail/Messages row.
struct AgentRow: View {
    var agent: Agent?
    var title: String
    var subtitle: String?
    var trailing: String? = nil

    var body: some View {
        HStack(spacing: 12) {
            AvatarView(agent: agent, size: 40)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    Text(title).font(.headline).lineLimit(1)
                    Spacer(minLength: 4)
                    if let trailing { Text(trailing).font(.caption).foregroundStyle(.secondary) }
                }
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                }
            }
        }
    }
}

/// A section the web way: a small muted title over plain rows.
struct PageSection<Content: View>: View {
    var title: String
    @ViewBuilder var content: Content
    init(_ title: String, @ViewBuilder content: () -> Content) { self.title = title; self.content = content() }
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).text(.lg, .semibold).foregroundStyle(Theme.fg).padding(.bottom, 4)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension View {
    /// Runs `action` on a real tap only. A Button also fires when a swipe starts and ends on it, so swiping
    /// the page (to open the drawer, or just scrolling sideways) opened whatever the finger let go on.
    func tapOnly(_ action: @escaping () -> Void) -> some View {
        contentShape(.rect)
            .onTapGesture(perform: action)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
    }
}
