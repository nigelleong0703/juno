import Foundation

/// The Today header of the Chat tab, read from `GET /v1/today` (contracts 0.18) into non-optional shapes the views can
/// use; offline, `World.today` composes it from what the app already holds.
struct TodaySummary: Equatable {
    enum UserState { case new, starting, regular }
    struct NeedsYouRow: Equatable { var requestId: String; var agentId: String?; var conversationId: String?; var title: String }
    struct Working: Equatable { var agentId: String; var runId: String; var title: String }
    struct Completed: Equatable { var runId: String; var agentId: String; var title: String }
    struct Brief: Equatable { var routineId: String; var postIds: [String]; var summary: String; var at: Date }
    enum Action: Equatable {
        case chat(agentId: String?, text: String)
        /// "Turn on a capability": target is connector, computer or profile.
        case unlock(target: String, connectorId: String?, agentId: String?)
    }
    struct Inspiration: Equatable, Identifiable {
        var id: String
        var title: String
        /// What the user would say, as the suggestion's main line (nil: the title is).
        var prompt: String?
        var agentId: String?
        var reason: String?
        var action: Action
    }
    var userState: UserState
    var needsYouCount: Int
    var needsYouTop: [NeedsYouRow]
    var working: [Working]
    var completed: [Completed]
    var inspiration: [Inspiration]
    var brief: Brief?
}

extension World {
    /// The server's Today (GET /v1/today) once it has arrived, else composed from what the app already holds (offline).
    var today: TodaySummary {
        guard let remote = todayRemote else { return composedToday }
        let top = remote.needsYou?.top ?? []
        let quiet: (Contract.Today.NeedsYou.TopItem) -> Bool = { row in row.requestId.flatMap { self.request($0) }.map { self.isQuiet($0) } ?? false }
        let quietInTop = top.filter(quiet).count
        return TodaySummary(
            userState: ["new": .new, "starting": .starting][remote.userState ?? ""] ?? .regular,
            needsYouCount: max(0, (remote.needsYou?.count ?? 0) - quietInTop),
            needsYouTop: top.filter { !quiet($0) }.compactMap { row in
                row.requestId.map { TodaySummary.NeedsYouRow(requestId: $0, agentId: row.agentId, conversationId: request($0)?.conversationId, title: request($0)?.payload?.brief?.sentence ?? row.title ?? "") }
            },
            working: (remote.working ?? []).compactMap { w in
                w.agentId.flatMap { a in w.runId.map { TodaySummary.Working(agentId: a, runId: $0, title: w.title ?? "") } }
            },
            completed: (remote.completed ?? []).compactMap { c in
                c.runId.flatMap { r in c.agentId.map { TodaySummary.Completed(runId: r, agentId: $0, title: c.title ?? "") } }
            }.filter { !runsSeen.contains($0.runId) },
            inspiration: (remote.inspiration ?? []).compactMap(Self.card).filter { !inspirationHidden.contains($0.id) },
            brief: remote.brief.flatMap { b in
                b.at.map { TodaySummary.Brief(routineId: b.routineId ?? "", postIds: b.postIds ?? [], summary: b.summary ?? "", at: $0) }
            })
    }

    private static func card(_ i: Contract.Inspiration) -> TodaySummary.Inspiration? {
        guard let title = i.title, let action = i.action else { return nil }
        let todo: TodaySummary.Action
        if action.type == "chat" { todo = .chat(agentId: action.agentId, text: action.text ?? i.prompt ?? "") }
        else if action.type == "unlock", let target = action.target, ["connector", "computer", "profile"].contains(target) {
            todo = .unlock(target: target, connectorId: action.connectorId, agentId: action.agentId)
        }
        else { return nil }
        return TodaySummary.Inspiration(id: i.id, title: title, prompt: i.prompt, agentId: i.agentId, reason: i.reason, action: todo)
    }

    private var composedToday: TodaySummary {
        let pending = needsYou
        let top = pending.prefix(2).map {
            TodaySummary.NeedsYouRow(requestId: $0.id, agentId: $0.agentId, conversationId: $0.conversationId,
                                     title: $0.payload?.brief?.sentence ?? $0.title ?? $0.payload?.ui?.title ?? Fmt.requestTitle($0.kind))
        }
        let working = runs.filter { $0.parentRunId == nil && ["running", "queued"].contains($0.status ?? "") }
            .compactMap { run in run.agentId.map { TodaySummary.Working(agentId: $0, runId: run.id, title: run.title ?? "") } }
        return TodaySummary(userState: agents.isEmpty ? .new : .regular, needsYouCount: pending.count, needsYouTop: Array(top),
                            working: working, completed: [], inspiration: [], brief: briefToday)
    }

    /// Today's feed posts (since local midnight) as one brief, as the server words it: the newest post's title and "· N more".
    private var briefToday: TodaySummary.Brief? {
        let posts = postsToday
        guard let first = posts.first else { return nil }
        let title = first.title ?? first.cardSummary ?? "New post"
        let summary = posts.count == 1 ? title : "\(title) · \(posts.count - 1) more"
        return TodaySummary.Brief(routineId: first.routineId ?? "", postIds: posts.map(\.id), summary: summary, at: first.createdAt ?? Date())
    }

    /// Posts created since local midnight, newest first.
    var postsToday: [FeedPost] {
        let start = Calendar.current.startOfDay(for: Date())
        return feed.filter { ($0.createdAt ?? .distantPast) >= start }
    }

    /// The Feed tab's badge: today's posts newer than the last time the Feed tab was opened.
    var unseenFeedToday: Int {
        let seen = feedSeenAt
        return postsToday.filter { ($0.createdAt ?? .distantPast) > seen }.count
    }

    func markFeedSeen() {
        feedSeenAt = Date()
        UserDefaults.standard.set(feedSeenAt.timeIntervalSince1970, forKey: "feedSeenAt")
    }

    /// "Still up? / Good morning / afternoon / evening" for the local hour (late night 0–5 asks instead of greeting).
    /// The server's hour (the owner's own clock) wins over the phone's.
    func greeting(name: String) -> String { Self.greeting(hour: todayRemote?.now?.hour ?? Calendar.current.component(.hour, from: Date()), name: name) }

    /// Same bands as the web Today page: late night 0–5 asks "Still up, robin?" instead of greeting.
    static func greeting(hour: Int, name: String) -> String {
        if hour < 5 { return name.isEmpty ? "Still up?" : "Still up, \(name)?" }
        let base = switch hour {
        case 5..<12: "Good morning"
        case 12..<18: "Good afternoon"
        default: "Good evening"
        }
        return name.isEmpty ? base : "\(base), \(name)"
    }
}
