import Foundation
import SwiftUI
import UIKit
import Observation

@MainActor
@Observable
final class World {
    var agents: [Agent] = []
    var members: [Member] = []
    var conversations: [Conversation] = []
    var items: [String: [Item]] = [:]
    /// Chats whose first page is being fetched (nothing stored on the device yet): the transcript stays empty until it
    /// lands, so a partial list is never shown and then swapped out.
    var itemsLoading: Set<String> = []
    /// What each chat knows about the history behind its in-memory window (cursor for older pages, detached, ...).
    var history: [String: ChatHistory] = [:]
    /// Authoritative TEXT_MESSAGE_* fragments until END commits the item. The item row remains the transcript truth.
    @ObservationIgnored var aguiStreaming: [String: [String: AguiStreamingMessage]] = [:]
    /// The on-device database (Core/LocalStore.swift); nil before sign-in.
    @ObservationIgnored var store: LocalStore?
    @ObservationIgnored var storeKey: String?
    /// Items that arrive live while a chat's newest page is being fetched: merged into it when it lands.
    @ObservationIgnored var fetching: [String: [Item]] = [:]
    @ObservationIgnored var cursorTask: Task<Void, Never>?
    @ObservationIgnored var lastCursor: Int?
    @ObservationIgnored var conversationsSaveTask: Task<Void, Never>?
    var runs: [Run] = []
    /// Helper runs spawned by a task (kind background, with a parent), by run id. They stay out of `runs` so no chat or
    /// status screen counts them; only the task detail reads them.
    var childRuns: [String: Run] = [:]
    var plans: [Plan] = []
    var requests: [AgentRequest] = []
    var library: [LibraryItem] = []
    var routines: [Routine] = []
    /// The agents' own calendar items for the day the routines calendar shows (see World+Calendar).
    var calendarItems: [Contract.AgentCalendarItem] = []
    var skills: [Skill] = []
    var rules: [Rule] = []
    /// The Rules page's Activity list (GET /v1/audit), loaded when that tab opens (World+Activity).
    var activity = ActivityLog()
    var computers: [Computer] = []
    var usage: Usage?
    var goals: [PlannedGoal] = []
    var ideas: [PlannedIdea] = []
    var feed: [FeedPost] = []
    /// The owner's Spaces (GET /v1/spaces); the Library's Shared filter lists the ones with a hosted link.
    var spaces: [Contract.Space] = []
    /// Documents the app has opened or shown a cell for, by id, with their open draft (World+Documents).
    var documents: [String: DocView] = [:]
    /// The server's Today (GET /v1/today); nil until loaded.
    var todayRemote: Contract.Today?
    /// Inspiration cards and finished runs the user has dismissed / opened, hidden at once until the server agrees.
    var inspirationHidden: Set<String> = []
    var runsSeen: Set<String> = []
    /// A line the Feed tab shows for a few seconds ("Added …" after an inspiration card created a source).
    var feedNotice: String?
    /// "Not for me" just chosen: the post is hidden and the server hears of it when this toast times out (Undo cancels).
    var feedToast: FeedToast?
    /// "Not now" or "Less like this" on an idea just chosen: what was decided, with Undo when it made a rule (Ideas tab).
    var proactiveToast: ProactiveToast?
    /// Text for the composer of the agent the user is about to create (an inspiration starter with no agent yet).
    var starterText: String?
    @ObservationIgnored var todayTask: Task<Void, Never>?
    /// The account's model providers and whether an agent can run at all (GET /v1/model-providers); nil until loaded.
    var modelProviders: ModelProviderList?
    /// The owner's Mac as a computer for agents (GET /v1/computers/my-mac): paired or not, online or not. nil until loaded.
    var myMac: Contract.MacStatus?
    /// Every app with this account's installations and the agents that may use it (GET /v1/apps); nil until loaded.
    var apps: [Contract.App]?
    /// The last list fetch failed and there is nothing to show: the Apps page offers a retry instead of an empty list.
    var appsLoadFailed = false
    /// An app's detail (GET /v1/apps/:id): capabilities, pending installs, skills.
    var appDetails: [String: Contract.AppDetail] = [:]
    /// Agent filter shared by every top-level tab (nil = all agents). Set from the header picker.
    var scope: String?
    var doing: [String: String] = [:]
    /// Bumped on every `agent.home.changed` event; home-file screens reload when it changes.
    var homeRevision = 0
    /// Text to prefill in a conversation's composer (Ideas → "Do it").
    var drafts: [String: String] = [:]
    /// The message each conversation's composer is replying to (swipe or long-press → Reply).
    var replyTo: [String: Item] = [:]
    /// Attachments the user picked in the composer, shown as chips on their message (mock only).
    var attachments: [String: [String]] = [:]

    // MARK: Navigation (Muse-style: the chat is the root, ≡ switches conversations)

    /// The selected tab: today · chat · team · discover · library (owner-approved 2026-10-26). The Feed, Ideas and Goals
    /// pages are no longer tabs: their old keys still arrive from chats, pushes and the drawer, and open the page on the
    /// tab that now holds it (Feed and Ideas under Today, Goals under Team).
    var tab = "chat" {
        didSet {
            switch tab {
            case "feed": tab = "today"; pendingRoute = .feed
            case "ideas": tab = "today"; pendingRoute = .ideas
            case "goals": tab = "team"; pendingRoute = .goalList
            default: break
            }
        }
    }
    /// When the Feed tab was last opened (this device): the Feed badge counts today's newer posts.
    var feedSeenAt = Date(timeIntervalSince1970: UserDefaults.standard.double(forKey: "feedSeenAt"))
    /// A Feed post to bring into view and highlight (set by a chat's "Posted to Feed" card).
    var feedFocus: String?
    /// My reaction per message id (on this device; the server has no reactions yet).
    var reactions: [String: String] = (UserDefaults.standard.dictionary(forKey: "reactions") as? [String: String]) ?? [:]
    /// The ☰ sidebar is open (the page is slid right).
    var sidebarOpen = false
    /// Screens that use a right swipe themselves (`.noDrawerSwipe()`) while visible; the drawer pan stays out.
    var drawerSwipeBlockers = 0
    var currentConversationId: String?
    /// The app is in the foreground: an open chat's incoming items are read on arrival.
    var appActive = true
    var markReadTask: Task<Void, Never>?
    var sheet: SheetRoute?
    /// The agent page (presented once at the root, zooming out of the avatar named by `sourceId`).
    var agentPage: AgentPageTarget?
    /// The Feed post page (a full-screen cover like the agent page, zooming out of the card `feed-<id>`).
    var postPage: String?
    /// A page asked for from outside any stack (a sidebar row, an unlock card): the tab bar pushes it onto the current tab.
    var pendingRoute: Route?
    func openAgentPage(_ agentId: String, from sourceId: String, tab: String? = nil) { agentPage = AgentPageTarget(agentId: agentId, sourceId: sourceId, tab: tab) }


    /// Team's Memory and People (lists and detail pages share them).
    @ObservationIgnored let teamMemory = TeamMemoryStore()
    @ObservationIgnored let teamPeople = TeamPeopleStore()

    /// Per-collection decode failures, shown in the UI instead of failing silently.
    var loadErrors: [String] = []

    // MARK: Lookups

    var pending: [AgentRequest] { requests.filter { $0.status == "pending" }.sorted { ($0.createdAt ?? .distantPast) > ($1.createdAt ?? .distantPast) } }
    func agent(_ id: String?) -> Agent? { agents.first { $0.id == id } }
    func member(_ id: String?) -> Member? { members.first { $0.id == id } }
    func run(_ id: String?) -> Run? { runs.first { $0.id == id } }
    /// One-agent chats take that agent's character tint (lib/avatars.ts CHARACTER_TINT). Groups stay neutral.
    func accent(for conversationId: String) -> Color? {
        guard let c = conversation(conversationId), c.kind != "room", let id = c.agentIds?.first, c.agentIds?.count == 1 else { return nil }
        return agentTint(agent(id))
    }

    // MARK: Lazy live data (fetched on demand)

    /// Per-agent todo plans across chats (GET /v1/agents/:id/plans).
    var planItems: [String: [Item]] = [:]
    /// Per-agent task list (GET /v1/agents/:id/tasks, kept live by `task.updated`).
    var tasks: [String: [Contract.AgentTask]] = [:]
    /// Where the next page of older ended tasks starts, per agent (nil when there is none).
    var taskNext: [String: String] = [:]
    /// Tap targets of an agent's screen while the user controls it (GET /v1/screens/:id/elements).
    var screenElements: [String: Contract.ScreenElements] = [:]
    /// Decided requests per agent (the Permissions tab's History), newest first, paged.
    var decided: [String: DecidedRequests] = [:]
    /// Standing grants per agent (GET /v1/rules?agentId=).
    var grants: [String: [Rule]] = [:]
    /// What each agent may decide alone (GET /v1/delegations?agentId=): rules with scope `delegation`.
    var delegationRules: [String: [Rule]] = [:]
    /// Purchase / take-over previews fetched from the library, by library id.
    var previewImages: [String: UIImage] = [:]
    /// Latest screenshot per agent (GET /v1/screens/:id/screenshot).
    var screenshots: [String: UIImage] = [:]
    @ObservationIgnored var stepsLoaded: Set<String> = []
    private var screenIds: [String: String] = [:]
    /// Known to have a display (live). An agent gets one the first time it uses its computer.
    func hasScreen(_ agentId: String) -> Bool { screenIds[agentId] != nil }

    /// Drop the cached display id so the next `screenId(for:)` asks the server again.
    func forgetScreen(_ agentId: String) { screenIds[agentId] = nil }

    /// The control epoch last seen per screen id (`ScreenResponse.controlEpoch`, then `control.changed`): bumped by the server on every
    /// change of who holds the screen, and sent back with a take-over or return so a stale tap changes nothing.
    var controlEpochs: [String: Int] = [:]

    /// The agent's display on its computer (nil: no computer or no display yet).
    func screenId(for agentId: String) async -> String? {
        if let id = screenIds[agentId] { return id }
        guard let api, agent(agentId) != nil else { return nil }
        guard let screen = try? await api.get("/v1/computers/default/agents/\(agentId)/screen", as: Contract.ScreenResponse.self) else { screenIds[agentId] = nil; return nil }
        screenIds[agentId] = screen.id
        noteEpoch(of: screen)
        return screen.id
    }

    /// Remembers the control epoch of a screen row the server answered.
    func noteEpoch(of screen: Contract.ScreenResponse) {
        if let epoch = screen.controlEpoch, epoch >= (controlEpochs[screen.id] ?? 0) { controlEpochs[screen.id] = epoch }
    }

    /// `control.changed` for a screen: the new holder and epoch (an event older than what is known, a replay, changes nothing).
    func applyScreenControl(screenId: String, holder: String, epoch: Int) {
        guard epoch >= (controlEpochs[screenId] ?? 0) else { return }
        controlEpochs[screenId] = epoch
        if !computers.isEmpty, screenIds.values.contains(screenId) { computers[0].controller = holder == "user" ? "user" : "agent" }
    }








    /// The chat's items plus one row for each top-level run that failed or was stopped without any agent reply
    /// (the backend writes no `run` items), so a failure is never silent. Sorted by time.
    func transcript(_ conversationId: String) -> [Item] {
        if !chatLoaded(conversationId) { return [] }
        let list = items[conversationId] ?? []
        let referenced = Set(list.filter { $0.type == "agent_message" }.compactMap(\.runId))
        // Older runs belong to history that is not in the window yet: they join when their page does.
        let windowStart = history[conversationId]?.reachedStart == false ? list.first?.at : nil
        let loose = runs.filter {
            $0.conversationId == conversationId && $0.parentRunId == nil && !referenced.contains($0.id)
                && ["failed", "stopped"].contains($0.status ?? "")
                && ($0.startedAt ?? .distantFuture) >= (windowStart ?? .distantPast)
        }
            .map { Item(id: "run-\($0.id)", conversationId: conversationId, at: $0.startedAt, type: "run", runId: $0.id) }
        guard !loose.isEmpty else { return list }
        return (list + loose).sorted { ($0.at ?? .distantPast) < ($1.at ?? .distantPast) }
    }
    /// The chat's window is ready to show (before sign-in there is nothing to wait for).
    func chatLoaded(_ id: String) -> Bool { api == nil || (items[id] != nil && !itemsLoading.contains(id)) }
    func request(_ id: String?) -> AgentRequest? { requests.first { $0.id == id } }
    func file(_ id: String?) -> LibraryItem? { library.first { $0.id == id } }
    func routine(_ id: String?) -> Routine? { routines.first { $0.id == id } }
    func conversation(_ id: String?) -> Conversation? { conversations.first { $0.id == id } }
    var computer: Computer? { computers.first }

    /// Pinned first, then most recent.
    var sortedConversations: [Conversation] {
        conversations.sorted {
            if ($0.pinned ?? false) != ($1.pinned ?? false) { return $0.pinned ?? false }
            return ($0.lastItemAt ?? .distantPast) > ($1.lastItemAt ?? .distantPast)
        }
    }

    func directConversation(for agentId: String) -> Conversation? {
        conversations.first { $0.kind == "direct" && $0.agentIds == [agentId] }
    }

    /// A question or connect card in a direct chat is the agent talking, not the owner being needed: it stays inline in
    /// its chat and counts nowhere as "needs you". Approvals, sign-in, secure input and take-over still do.
    func isQuiet(_ request: AgentRequest) -> Bool {
        (request.flavor == .question || request.flavor == .connect) && conversation(request.conversationId)?.kind == "direct"
    }
    var needsYou: [AgentRequest] { pending.filter { !isQuiet($0) } }
    func needsYou(in conversationId: String) -> [AgentRequest] { needsYou.filter { $0.conversationId == conversationId } }
    func needsYou(of agentId: String) -> [AgentRequest] { needsYou.filter { $0.agentId == agentId } }
    func pending(in conversationId: String) -> [AgentRequest] { pending.filter { $0.conversationId == conversationId } }
    func pending(of agentId: String) -> [AgentRequest] { pending.filter { $0.agentId == agentId } }

    static let activeStatuses: Set<String> = ["running", "queued", "waiting_for_input", "blocked"]
    func activeRuns(of agentId: String) -> [Run] { runs.filter { $0.agentId == agentId && Self.activeStatuses.contains($0.status ?? "") } }
    func activeRuns(in conversationId: String) -> [Run] { runs.filter { $0.conversationId == conversationId && Self.activeStatuses.contains($0.status ?? "") } }
        func plan(in conversationId: String) -> Plan? {
        plans.last { $0.conversationId == conversationId }
            ?? items[conversationId]?.last { $0.type == "plan" }.map { Plan(id: $0.id, conversationId: conversationId, runId: $0.runId, title: run($0.runId)?.title, todos: $0.todos) }
    }
    func files(in conversationId: String) -> [LibraryItem] { library.filter { $0.conversationId == conversationId } }

    /// The one line under an agent's name, always in the agent's words and never the owner's message: its progress or live
    /// "doing" line, else the title it gave its run (`titleGenerated`), else the summary it wrote of its last run, else "Free".
    /// A run's title is the owner's raw message until the agent names it, so an unnamed title is never shown.
    func doingLine(_ agent: Agent) -> String {
        if let progress = tasks[agent.id]?.first(where: { $0.status == "running" })?.progress, !progress.isEmpty { return progressText(progress) }
        if (agent.needsYou ?? 0) > 0 || !needsYou(of: agent.id).isEmpty, doing[agent.id] == nil {
            return "Waiting on you"
        }
        let mine = runs.filter { $0.agentId == agent.id }
        // What the owner said: the titles no agent has replaced yet. The server's live line falls back to one of these.
        let said = Set(mine.filter { $0.titleGenerated != true }.compactMap { $0.title.map(Self.withoutLeadingMentions) })
        func clean(_ text: String?) -> String? {
            guard let text else { return nil }
            let line = Self.withoutLeadingMentions(text).trimmingCharacters(in: .whitespacesAndNewlines)
            return line.isEmpty || Self.isInternalNote(line) || said.contains(line) ? nil : line
        }
        func named(_ run: Run?) -> String? { run?.titleGenerated == true ? clean(run?.title) : nil }
        if let live = clean(doing[agent.id]) { return live }
        if let active = activeRuns(of: agent.id).first { return named(active) ?? "Working on it" }
        let latest = mine.filter { $0.parentRunId == nil }.max { ($0.startedAt ?? .distantPast) < ($1.startedAt ?? .distantPast) }
        if let line = named(latest) ?? clean(latest?.summary) { return line }
        if let last = clean(agent.lastActivity), !Self.placeholderActivities.contains(last) { return last }
        return Self.freeLine
    }

    /// What the line says when the agent has nothing going on and nothing of its own to report.
    static let freeLine = "Free"
    /// The server's placeholder `lastActivity` of an agent nobody has talked to yet or that was just created: never a doing line.
    static let placeholderActivities: Set<String> = ["Just created", "Created"]

    /// The server's placeholder role (`title`) of an agent with none: shown as no role.
    static let defaultRole = "New agent"

    /// The agent's role for display: nil while it is blank or the server's placeholder.
    func role(_ agent: Agent) -> String? {
        let role = (agent.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return role.isEmpty || role == Self.defaultRole || role == "Agent" ? nil : role
    }

    static func withoutLeadingMentions(_ text: String) -> String {
        text.replacingOccurrences(of: #"^(\s*@\S+)+\s*"#, with: "", options: .regularExpression)
    }

    static func isInternalNote(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("[system note")
    }

    // MARK: Mutations — update locally at once, then tell the backend when signed in

    /// Signed-in backend; nil before sign-in.
    var api: API?
    var session: Session?
    /// The account's user id: user_messages with this author are "mine".
    var selfId = ""
    var syncError: String?
    @ObservationIgnored var streamTask: Task<Void, Never>?
    /// Identity fence for the stream callbacks: an old account's reconnect can never write into the new world.
    @ObservationIgnored var streamToken = UUID()

    func remote(_ work: @escaping @MainActor (API) async throws -> Void) {
        guard let api else { return }
        Task { @MainActor in
            do { try await work(api) } catch where !error.isCancellation { self.syncError = error.localizedDescription } catch {}
        }
    }


    /// Live updates (SSE) are connected; false while it reconnects, so the chat can say updates may lag.
    var streamLive = true
    /// Returning from the background drops and reopens the stream; until this time a down stream is not worth a "Reconnecting…".
    var streamGraceUntil = Date.distantPast
    nonisolated static let reconnectGrace: TimeInterval = 4
    /// "Reconnecting…" shows only if the stream is still down after the resume grace AND something is pending or running.
    nonisolated static func showsReconnecting(live: Bool, now: Date, graceUntil: Date, busy: Bool) -> Bool {
        !live && busy && now >= graceUntil
    }
    /// My messages not yet accepted by the server, by local item id: nil = sending, text = why it failed.
    var outbox: [String: String?] = [:]
    /// Server item id -> the local id the message was shown under while it sent. The chat list keeps the local id,
    /// so the swap to the server's item is not a remove + insert.
    var displayIds: [String: String] = [:]
}

extension Error {
    /// A request dropped because its task or view went away: not something to tell the user about.
    var isCancellation: Bool {
        self is CancellationError || (self as? URLError)?.code == .cancelled
    }
}
