import Foundation
import SwiftUI
import UIKit
import UserNotifications

struct AguiStreamingMessage: Equatable {
    var conversationId: String
    var runId: String
    var agentId: String
    var messageId: String
    var text: String
    var startedAt: Date
}

private extension JSONValue {
    var object: [String: JSONValue]? { if case .object(let value) = self { value } else { nil } }
    var int: Int? { if case .number(let value) = self { Int(exactly: value) } else { nil } }
    var textContent: String? {
        if case .string(let value) = self { return value }
        guard case .array(let parts) = self else { return nil }
        return parts.compactMap { part in
            guard let object = part.object, object.string("type") == "text" else { return nil }
            return object.string("text")
        }.joined()
    }
}

private extension Dictionary where Key == String, Value == JSONValue {
    var junoObject: [String: JSONValue]? { self["juno"]?.object }
    func string(_ key: String) -> String? { self[key]?.string }
    func int(_ key: String) -> Int? { self[key]?.int }
    func bool(_ key: String) -> Bool? { self[key]?.bool }
}

private extension Contract.AgentEvent {
    var aguiDate: Date? {
        guard let timestamp else { return nil }
        return Date(timeIntervalSince1970: Double(timestamp) / 1000)
    }
}

private func decodeJSONValue<T: Decodable>(_ value: JSONValue) -> T? {
    guard let data = try? JSONEncoder().encode(value) else { return nil }
    return try? isoDecoder.decode(T.self, from: data)
}

extension World {
    /// "Set time zone automatically": tell the server this device's zone (unless the owner chose one by hand)
    /// and its BCP 47 locale, only what changed. Failures are only logged; the next foreground retries.
    @MainActor
    func reportTimeZone() async {
        guard let api else { return }
        struct General: Codable { var timezone: String?; var timezoneAuto: Bool?; var locale: String? }
        struct Settings: Codable { var general: General? }
        let zone = TimeZone.current.identifier
        let locale = Locale.current.identifier(.bcp47)
        do {
            let general = try await api.get("/v1/settings", as: Settings.self).general
            var patch = General()
            if general?.timezoneAuto != false, general?.timezone != zone { patch.timezone = zone }
            if general?.locale != locale { patch.locale = locale }
            guard patch.timezone != nil || patch.locale != nil else { return }
            try await api.patch("/v1/settings", Settings(general: patch))
        } catch {
            print("Could not report the device time zone: \(error)")
        }
    }

    // MARK: Live loading

    /// Loads the signed-in account's data, then follows the event stream.
    @MainActor
    func connect(_ session: Session) async throws {
        let api = API(session: session)
        restore(session, present: false)
        // Where live updates start. A stored cursor resumes the stream exactly where the device left off (the
        // server replays what was missed, or sends `reset`). With none (first install, or the server was reset
        // below it) it is taken before the snapshot, so the stream only carries what happened since.
        struct Cursor: Decodable { var after: Int }
        let head = try? await api.get("/v1/events/cursor", as: Cursor.self)
        var resumeAfter = store?.cursor()
        if let stored = resumeAfter, let head, stored > head.after { resumeAfter = nil }
        let seed = resumeAfter == nil
        if seed { store?.wipeHistory(); items = [:]; history = [:]; resumeAfter = head?.after; if let a = head?.after { store?.setCursor(a) } }
        async let agents = api.list("/v1/agents?limit=200", as: Agent.self)
        async let conversations = api.list("/v1/conversations?limit=200", as: Conversation.self)
        async let runs = api.list("/v1/runs?limit=200", as: Run.self)
        async let requests = api.list("/v1/requests?limit=200", as: AgentRequest.self)
        async let library = api.list("/v1/library?limit=200", as: LibraryItem.self)
        async let routines = api.list("/v1/routines?limit=200", as: Routine.self)
        async let skills = api.list("/v1/skills?limit=200", as: Skill.self)
        async let rules = api.list("/v1/rules?limit=200", as: Rule.self)
        async let computers = api.list("/v1/computers", as: Computer.self)
        async let goals = api.list("/v1/goals?limit=200", as: PlannedGoal.self)
        async let ideas = api.list("/v1/ideas?limit=200", as: PlannedIdea.self)
        async let feed = api.list("/v1/feed?limit=100", as: FeedPost.self)
        let loaded = try await (agents, conversations, runs, requests)
        self.agents = loaded.0
        self.conversations = loaded.1
        // Housekeeping runs (memory jobs) are the agent's own upkeep, not work for the user: never shown as activity or status.
        self.runs = loaded.2.filter { $0.kind != "background" }
        self.childRuns = Dictionary(loaded.2.filter { $0.kind == "background" && $0.parentRunId != nil }.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
        self.requests = loaded.3
        // Secondary lists: a missing endpoint on an older server must not block sign-in.
        self.library = (try? await library) ?? []
        self.routines = (try? await routines) ?? []
        self.skills = (try? await skills) ?? []
        self.rules = (try? await rules) ?? []
        self.computers = (try? await computers) ?? []
        let liveGoals: [PlannedGoal] = (try? await goals) ?? []
        let liveIdeas: [PlannedIdea] = (try? await ideas) ?? []
        self.goals = liveGoals.filter { $0.status != "done" }
        self.ideas = liveIdeas.filter { $0.status == nil || $0.status == "open" }
        self.feed = Self.newestFirst((try? await feed) ?? [])
        scheduleTodayRefresh(now: true)
        self.usage = try? await api.get("/v1/usage", as: Usage.self)
        self.plans = []; self.members = []; self.doing = [:]; self.attachments = [:]
        self.activity = ActivityLog(); self.scope = nil
        self.tasks = [:]; self.planItems = [:]; self.decided = [:]; self.grants = [:]; self.screenElements = [:]
        self.selfId = session.userId
        self.session = session
        self.api = api
        self.loadErrors = []
        persistSnapshot()
        // The app opens on Chat; keep a chat already opened (a link or launch argument) if it exists on this server.
        if !self.conversations.contains(where: { $0.id == self.currentConversationId }) { self.currentConversationId = nil }
        if let c = currentConversationId { loadItems(c) }
        startStream(session, after: resumeAfter)
        if seed { Task { await seedRecentChats() } }
        PushRegistrar.shared.signedIn(api)
        await refreshModelProviders()
    }

    func signOut() {
        PushRegistrar.shared.signingOut()
        PhoneDevice.shared.signingOut()
        streamTask?.cancel()
        streamToken = UUID()
        SessionStore.save(nil)
        // The next account must not find anything of this one on the device.
        store = nil; storeKey = nil; history = [:]; itemsLoading = []; fetching = [:]
        cursorTask?.cancel(); cursorTask = nil; conversationsSaveTask?.cancel(); conversationsSaveTask = nil
        LocalStore.deleteAll()
        api = nil; session = nil
        agents = []; members = []; conversations = []; items = [:]
        runs = []; plans = []; requests = []; library = []; routines = []
        skills = []; rules = []; activity = ActivityLog(); computers = []; apps = nil; appDetails = [:]; appsLoadFailed = false
        usage = nil; goals = []; ideas = []; doing = [:]; selfId = ""
        feed = []; todayRemote = nil; inspirationHidden = []; runsSeen = []; scope = nil; modelProviders = nil
        tasks = [:]; planItems = [:]; decided = [:]; grants = [:]; screenElements = [:]
        aguiStreaming = [:]; controlEpochs = [:]
        currentConversationId = nil
    }

    func startStream(_ session: Session, after: Int? = nil) {
        streamTask?.cancel()
        let token = UUID()
        streamToken = token
        PhoneDevice.shared.signedIn(API(session: session))
        streamTask = Task { @MainActor in
            // Every (re)connect re-reads the agents: an event missed while the stream was down is never replayed.
            let stream = EventStream(session: session, after: after.map(String.init), onLive: { live in
                guard self.streamToken == token else { return }
                self.streamLive = live
                PhoneDevice.shared.streamChanged(live)
                if live { Task { await self.refreshAgents(); await self.refreshRequests() } }
            })
            for await frame in stream.frames() {
                guard !Task.isCancelled, self.streamToken == token else { return }
                if frame.isReset { await self.handleReset(); continue }
                self.apply(frame.data)
                if let id = frame.id { self.noteCursor(id) }
            }
        }
    }

    /// Agent statuses are kept live by `agent.status` events, which a backgrounded app can miss: re-read the list on
    /// foreground and on every stream reconnect. A "doing" line stays only for an agent that is still working.
    @MainActor
    func refreshAgents() async {
        guard let api, let fresh = try? await api.list("/v1/agents?limit=200", as: Agent.self) else { return }
        agents = fresh
        doing = doing.filter { id, _ in fresh.contains { $0.id == id && $0.status == "working" } }
    }

    /// `request.resolved` can be missed while the stream is down, which leaves a card pending (and counted in Needs you):
    /// re-read the requests on every reconnect and reset, like the agents.
    @MainActor
    func refreshRequests() async {
        guard let api, let fresh = try? await api.list("/v1/requests?limit=200", as: AgentRequest.self) else { return }
        requests = fresh
    }

    /// packages/client/src/events.ts: fold one event into the world.
    @MainActor
    func apply(_ frame: Data) {
        // Standard AG-UI chat events have their own lifecycle reducer. Product events continue through the
        // names below (agents, conversations, requests, items, feed, devices, ...).
        if applyAgui(frame) { return }
        struct Head: Decodable { var type: String; var agentId: String?; var status: String?; var doing: String?; var conversationId: String?; var runId: String?; var goalId: String? }
        struct E<T: Decodable>: Decodable { var agent: T?; var run: T?; var item: T?; var conversation: T?; var request: T?; var routine: T?; var goal: T?; var idea: T?; var step: T?; var post: T?; var task: T?; var artifact: T? }
        guard let head = try? isoDecoder.decode(Head.self, from: frame) else { return }
        // What the Today header shows changes with requests, runs and feed posts; the server's copy is re-read shortly after.
        if head.type.hasPrefix("request.") || head.type.hasPrefix("feed.") { scheduleTodayRefresh() }
        func upsert<T: Identifiable>(_ list: inout [T], _ value: T?) {
            guard let value else { return }
            if let i = list.firstIndex(where: { $0.id == value.id }) { list[i] = value } else { list.append(value) }
        }
        switch head.type {
        case "agent.status":
            if let id = head.agentId, let i = agents.firstIndex(where: { $0.id == id }) { agents[i].status = head.status }
            if let id = head.agentId { doing[id] = head.status == "working" ? head.doing : nil }
        case "agent.created", "agent.updated":
            upsert(&agents, (try? isoDecoder.decode(E<Agent>.self, from: frame))?.agent)
        case "agent.home.changed":
            homeRevision += 1
        case "agent.deleted":
            // Everything of a deleted agent goes, not just its row: its direct chats, runs, requests and tasks
            // (otherwise Home "Today" and the transcript kept showing them until a relaunch).
            if let agentId = head.agentId {
                agents.removeAll { $0.id == agentId }
                let gone = Set(conversations.filter { $0.agentIds == [agentId] }.map(\.id))
                conversations.removeAll { gone.contains($0.id) }
                for id in gone { items[id] = nil; history[id] = nil; store?.deleteChat(id) }
                persistConversationsSoon()
                runs.removeAll { $0.agentId == agentId }
                requests.removeAll { $0.agentId == agentId }
                tasks[agentId] = nil
            }
        case "item.added":
            if let c = head.conversationId, let item = (try? isoDecoder.decode(E<Item>.self, from: frame))?.item { receive(item, in: c) }
        case "artifact.updated":
            // A new version: the existing card shows it in place.
            if let a = (try? isoDecoder.decode(E<LibraryItem>.self, from: frame))?.artifact {
                if let i = library.firstIndex(where: { $0.id == a.id }) {
                    var merged = a
                    merged.pinned = a.pinned ?? library[i].pinned
                    merged.folder = a.folder ?? library[i].folder
                    library[i] = merged
                } else { library.append(a) }
                if a.render == "doc", documents[a.id] != nil { Task { try? await loadDocument(a.id) } }
            }
        case "document.draft.updated":
            // An agent proposed, the owner saved, or a draft was decided (BACKEND §5.11a).
            struct D: Decodable { var draft: DocDraft }
            if let draft = (try? isoDecoder.decode(D.self, from: frame))?.draft { applyDocumentDraft(draft) }
        case "conversation.created", "conversation.updated":
            upsert(&conversations, (try? isoDecoder.decode(E<Conversation>.self, from: frame))?.conversation)
            persistConversationsSoon()
        case "conversation.deleted":
            if let id = head.conversationId {
                conversations.removeAll { $0.id == id }
                items[id] = nil; history[id] = nil; store?.deleteChat(id)
                persistConversationsSoon()
                runs.removeAll { $0.conversationId == id }
                requests.removeAll { $0.conversationId == id }
            }
        case "request.created", "request.resolved":
            let request = (try? isoDecoder.decode(E<AgentRequest>.self, from: frame))?.request
            upsert(&requests, request)
            if head.type == "request.created", let request, ["approval", "question", "connect"].contains(request.kind ?? "") {
                // Name the agent that raised it (push banners do the same server-side).
                let name = request.agentId.flatMap { id in agents.first { $0.id == id }?.name } ?? "Your agent"
                LocalNotice.post(title: "\(name) needs you", body: request.sentence, conversationId: request.conversationId,
                                 requestId: request.id, id: "request-\(request.id)")
            }
        case "task.updated":
            applyTask((try? isoDecoder.decode(E<Contract.AgentTask>.self, from: frame))?.task)
        case "routine.updated":
            upsert(&routines, (try? isoDecoder.decode(E<Routine>.self, from: frame))?.routine)
        case "goal.updated":
            upsert(&goals, (try? isoDecoder.decode(E<PlannedGoal>.self, from: frame))?.goal)
        case "goal.deleted":
            goals.removeAll { $0.id == head.goalId }
        case "feed.created", "feed.updated":
            if let post = (try? isoDecoder.decode(E<FeedPost>.self, from: frame))?.post {
                upsert(&feed, post)
                feed = Self.newestFirst(feed)
            }
        case "control.changed":
            // Who may act on a surface changed: the person took a screen or handed it back, the Mac was Stopped or resumed.
            if let event = try? isoDecoder.decode(Contract.AgentEvent.self, from: frame), let holder = event.holder, let epoch = event.epoch {
                if event.surface?.kind == "mac" { applyMacControl(holder: holder, epoch: epoch, since: event.since) }
                else if let screenId = event.surface?.screenId { applyScreenControl(screenId: screenId, holder: holder, epoch: epoch) }
            }
        case "device.call":
            // The agent asks this iPhone for its calendar or reminders; only the app that declared answers.
            PhoneDevice.shared.handle(frame)
        case "feed.brief":
            // A routine posted: the new posts and Today's brief.
            Task { await reloadFeed() }
        case "idea.updated":
            if let idea = (try? isoDecoder.decode(E<PlannedIdea>.self, from: frame))?.idea {
                if idea.status == "open" { upsert(&ideas, idea) } else { ideas.removeAll { $0.id == idea.id } }
            }
        default: break
        }
    }

    // MARK: - AG-UI standard reducer

    private static let aguiRunTypes: Set<String> = ["RUN_STARTED", "RUN_FINISHED", "RUN_ERROR"]

    /// Folds one official AG-UI event. Returns false for a Juno product event, which the caller handles as before.
    @MainActor
    @discardableResult
    func applyAgui(_ frame: Data) -> Bool {
        guard let event = try? isoDecoder.decode(Contract.AgentEvent.self, from: frame), let type = event.type else { return false }
        let juno = event.metadata?.object?.junoObject
        if Self.aguiRunTypes.contains(type) || type.hasPrefix("STEP_") || type == "MESSAGES_SNAPSHOT" {
            scheduleTodayRefresh()
        }
        switch type {
        case "RUN_STARTED":
            if let row = aguiRun(event, juno: juno, status: juno?.string("runStatus") ?? "running") { upsertAguiRun(row) }
        case "RUN_FINISHED":
            let outcome = event.outcome?.type
            if outcome == "interrupt" { break }
            let status = juno?.string("runStatus") ?? (outcome == "cancelled" ? "stopped" : outcome == "success" ? "completed" : nil)
            if let status, let row = aguiRun(event, juno: juno, status: status, finished: true) {
                let previous = run(row.id) ?? childRuns[row.id]
                upsertAguiRun(row)
                notifyFinished(previous: previous, run: row)
            }
        case "RUN_ERROR":
            let message = event.message ?? "run failed"
            if let row = aguiRun(event, juno: juno, status: juno?.string("runStatus") ?? "failed", error: message, finished: true) {
                let previous = run(row.id) ?? childRuns[row.id]
                upsertAguiRun(row)
                notifyFinished(previous: previous, run: row)
            }
        case "STEP_STARTED", "STEP_FINISHED":
            aguiStep(event, juno: juno, finished: type == "STEP_FINISHED")
        case "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_CHUNK", "TEXT_MESSAGE_END":
            aguiText(event, juno: juno)
        case "MESSAGES_SNAPSHOT":
            aguiSnapshot(event)
        case "CUSTOM":
            aguiCustom(event, juno: juno)
        case "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_CHUNK", "TOOL_CALL_RESULT",
             "ACTIVITY_SNAPSHOT", "ACTIVITY_DELTA", "SUBAGENT_STARTED", "SUBAGENT_FINISHED", "SUBAGENT_ERROR",
             "STATE_SNAPSHOT", "STATE_DELTA", "RAW":
            break
        default:
            return false
        }
        return true
    }

    private static let aguiTerminal: Set<String> = ["completed", "failed", "stopped"]

    private func aguiRun(_ event: Contract.AgentEvent, juno: [String: JSONValue]?, status: String, error: String? = nil, finished: Bool = false) -> Run? {
        let id = juno?.string("runId") ?? event.runId
        guard let id else { return nil }
        let old = run(id) ?? childRuns[id]
        // A replay of RUN_STARTED must not pull a settled durable row back into work.
        if !finished, let old, Self.aguiTerminal.contains(old.status ?? "") { return nil }
        let agentId = juno?.string("agentId") ?? old?.agentId
        guard let agentId else { return nil }
        var row = old ?? Run(id: id, agentId: agentId, status: status)
        row.agentId = agentId
        row.conversationId = juno?.string("conversationId") ?? event.threadId ?? old?.conversationId
        row.status = status
        if let error { row.error = error }
        if finished { row.finishedAt = row.finishedAt ?? Date() }
        return row
    }

    private func upsertAguiRun(_ row: Run) {
        if row.kind == "background", row.parentRunId != nil {
            childRuns[row.id] = row
        } else if row.kind != "background" {
            if let i = runs.firstIndex(where: { $0.id == row.id }) { runs[i] = row } else { runs.append(row) }
        }
    }

    private func notifyFinished(previous: Run?, run row: Run) {
        guard previous?.status != row.status, row.kind == "chat", row.parentRunId == nil,
              row.status == "completed" || row.status == "failed" else { return }
        let name = row.agentId.flatMap { id in agents.first { $0.id == id }?.name } ?? "Your agent"
        LocalNotice.post(title: row.status == "completed" ? "\(name) finished" : "\(name) could not finish",
                         body: row.title ?? "", conversationId: row.conversationId, requestId: nil, id: "run-\(row.id)")
    }

    private func aguiStep(_ event: Contract.AgentEvent, juno: [String: JSONValue]?, finished: Bool) {
        guard let runId = juno?.string("runId") ?? event.runId, let stepId = juno?.string("stepId") else { return }
        let name = event.stepName ?? stepId
        func merge(_ row: Run) -> Run {
            var row = row
            var steps = row.steps ?? []
            if let i = steps.firstIndex(where: { $0.id == stepId }) {
                if Self.aguiSettledSteps.contains(steps[i].status ?? "") { return row }
                steps[i].title = steps[i].title ?? name
                steps[i].status = finished ? "completed" : "running"
            } else {
                steps.append(Step(id: stepId, index: steps.count, status: finished ? "completed" : "running", title: name))
            }
            row.steps = steps
            return row
        }
        if let i = runs.firstIndex(where: { $0.id == runId }) { runs[i] = merge(runs[i]) }
        else if let row = childRuns[runId] { childRuns[runId] = merge(row) }
    }

    private static let aguiSettledSteps: Set<String> = ["completed", "failed", "skipped"]

    /// A message the server sends as a finished paragraph: its frames are held until END commits the item. (There is no provisional
    /// streamed text any more: the server does not send previews.)
    private func aguiText(_ event: Contract.AgentEvent, juno: [String: JSONValue]?) {
        guard let messageId = event.messageId else { return }
        guard let conversationId = juno?.string("conversationId"), let runId = juno?.string("runId") else { return }
        if items[conversationId]?.contains(where: { $0.id == messageId }) == true { return }
        var buffers = aguiStreaming[runId] ?? [:]
        switch event.type {
        case "TEXT_MESSAGE_START":
            if buffers[messageId] == nil {
                buffers[messageId] = AguiStreamingMessage(conversationId: conversationId, runId: runId,
                    agentId: juno?.string("agentId") ?? "", messageId: messageId, text: "", startedAt: event.aguiDate ?? Date())
            }
        case "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_CHUNK":
            guard var held = buffers[messageId], let delta = event.delta?.string ?? event.content?.string else { return }
            held.text = event.type == "TEXT_MESSAGE_CHUNK" ? delta : held.text + delta
            buffers[messageId] = held
        case "TEXT_MESSAGE_END":
            guard let held = buffers[messageId] else { return }
            buffers[messageId] = nil
            aguiStreaming[runId] = buffers
            let item = Item(id: messageId, conversationId: conversationId, at: held.startedAt, type: "agent_message",
                            agentId: held.agentId, markdown: held.text, citations: [], runId: runId)
            if !held.text.isEmpty { receive(item, in: conversationId) }
            return
        default: return
        }
        aguiStreaming[runId] = buffers
    }

    private func aguiSnapshot(_ event: Contract.AgentEvent) {
        guard let conversationId = event.metadata?.object?.junoObject?.string("conversationId") ?? event.threadId else { return }
        for message in event.messages ?? [] {
            let meta = message.metadata?.object?.junoObject
            if let embedded = meta?["item"], let item: Item = decodeJSONValue(embedded) {
                receive(item, in: item.conversationId ?? conversationId)
                continue
            }
            guard let role = message.role, let text = message.content?.textContent else { continue }
            let at = event.aguiDate ?? Date()
            if role == "assistant", let agentId = meta?.string("agentId") {
                receive(Item(id: message.id, conversationId: conversationId, at: at, type: "agent_message",
                             agentId: agentId, markdown: text, citations: [], runId: meta?.string("runId")), in: conversationId)
            } else if role == "user", let authorId = meta?.string("authorId") {
                receive(Item(id: message.id, conversationId: conversationId, at: at, type: "user_message",
                             authorId: authorId, text: text, attachments: [], mentions: []), in: conversationId)
            }
        }
    }

    private func aguiCustom(_ event: Contract.AgentEvent, juno: [String: JSONValue]?) {
        guard event.name == "juno.run.updated", let raw = event.value, let row: Run = decodeJSONValue(raw) else { return }
        let previous = run(row.id) ?? childRuns[row.id]
        upsertAguiRun(row)
        notifyFinished(previous: previous, run: row)
    }

    static func newestFirst(_ posts: [FeedPost]) -> [FeedPost] {
        posts.sorted { ($0.createdAt ?? .distantPast) > ($1.createdAt ?? .distantPast) }
    }
}
