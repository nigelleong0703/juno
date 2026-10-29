import Foundation

/// How a task reads (same words as the web and Android apps): one label per `status` + `waitingFor` + `outcome`, a line for
/// `outcomeDetail`, and where a tap goes. The server decides the state; nothing here infers it from text.
enum TaskWords {
    /// The status pill: words and tone.
    static func phase(_ task: Contract.AgentTask) -> (label: String, tone: StatusTone) {
        switch task.status {
        case "queued": return ("Queued", .neutral)
        case "running": return ("Running", .success)
        case "waiting":
            switch task.waitingFor {
            case "approval": return ("Waiting for approval", .warning)
            case "event": return ("Waiting for an event", .warning)
            case "effect_review": return ("Needs your review", .warning)
            default: return ("Waiting for you", .warning)
            }
        default:
            switch task.outcome {
            case "failed": return ("Didn't finish", .danger)
            case "cancelled": return ("Stopped", .neutral)
            case "needs_input": return ("Needs your input", .warning)
            case "unknown_effect": return ("Outcome unknown, check before retrying", .warning)
            default: return ("Done", .success)
            }
        }
    }

    /// The specific reason behind an outcome, in words. `agentName` is the agent that stopped it, for "Stopped by <agent>".
    static func detail(_ task: Contract.AgentTask, agentName: String? = nil) -> String? {
        switch task.outcomeDetail {
        case "stopped_by_agent": "Stopped by \(agentName ?? "the agent")"
        case "stopped_by_system": "Stopped automatically"
        case "timed_out": "Timed out"
        case "step_limit": "Reached its step limit"
        case "no_progress": "Stopped making progress"
        case "verification_failed": "Could not verify the result"
        case "dispatch_failed": "Could not be started"
        case "state_unreadable": "Could not read its state"
        case "stopped_by_owner": "Stopped by you"
        case "stop_unconfirmed": "The stop may not have reached it"
        case "effect_review": "An outside action may have happened"
        default: nil
        }
    }

    /// The second line of a row: what it is doing now, the question it waits on, or how it ended.
    static func subtitle(_ task: Contract.AgentTask, agentName: String? = nil) -> String {
        switch task.status {
        case "queued": return task.outcomeDetail == "dispatch_failed" ? "Could not be started, will retry" : "Queued"
        case "running": return task.progress.map(progressText) ?? "Working…"
        case "waiting":
            let label = phase(task).label
            return task.progress.map { "\(label) \u{00B7} \(progressText($0))" } ?? label
        default:
            var lines: [String] = []
            for line in [detail(task, agentName: agentName), task.resultLine] { if let line, !line.isEmpty, !lines.contains(line) { lines.append(line) } }
            return lines.isEmpty ? phase(task).label : lines.joined(separator: " \u{00B7} ")
        }
    }

    /// How urgent a task's need for the person is: approval 4, a question 3, a review or unknown outcome 2, ended needing input 1, else 0.
    static func needsYouRank(_ task: Contract.AgentTask) -> Int {
        if task.status == "waiting" {
            switch task.waitingFor { case "approval": return 4; case "effect_review": return 2; case "event": return 0; default: return 3 }
        }
        if task.outcome == "unknown_effect" { return 2 }
        return task.outcome == "needs_input" ? 1 : 0
    }

    /// The conversation to open when a task needs the person: a question or approval it waits on, a recovery review of an action
    /// that may have happened, or an ended `needs_input`. That conversation holds the request card.
    static func needsYou(_ task: Contract.AgentTask) -> String? {
        let needs = (task.status == "waiting" && task.waitingFor != "event") || task.outcome == "needs_input" || task.outcome == "unknown_effect"
        return needs ? task.conversationId : nil
    }
}

/// A task with the tasks that hang under it.
struct TaskNode: Equatable, Identifiable {
    var task: Contract.AgentTask
    var children: [TaskNode]
    var id: String { task.id }
    var tasks: [Contract.AgentTask] { [task] + children.flatMap(\.tasks) }

    /// True when the task or anything under it needs the person (such children list first, so a cap never hides them).
    var subtreeNeedsYou: Bool { tasks.contains { TaskWords.needsYouRank($0) > 0 } }

    /// What a folded parent must not hide: the pill of the most urgent descendant that needs the person (approval, then a
    /// question, then a review or unknown outcome, then ended needing input) and the "N need you" line. Nil when none does.
    var descendantsNeedingYou: (label: String, tone: StatusTone, line: String)? {
        let below = children.flatMap(\.tasks).filter { TaskWords.needsYouRank($0) > 0 }
        guard let top = below.max(by: { TaskWords.needsYouRank($0) < TaskWords.needsYouRank($1) }) else { return nil }
        let phase = TaskWords.phase(top)
        return (phase.label, phase.tone, below.count == 1 ? "1 needs you" : "\(below.count) need you")
    }
}

/// A top-level row of the list: a task with its subtree, or a routine with its runs.
enum TaskEntry: Equatable, Identifiable {
    case task(TaskNode)
    case routine(id: String, runs: [TaskNode])

    var id: String {
        switch self {
        case .task(let node): node.id
        case .routine(let id, _): "routine-\(id)"
        }
    }
    var tasks: [Contract.AgentTask] {
        switch self {
        case .task(let node): node.tasks
        case .routine(_, let runs): runs.flatMap(\.tasks)
        }
    }
    /// Live while anything inside it is.
    var isLive: Bool { tasks.contains(where: TaskGroups.isActive) }
    var startedAt: Date { tasks.compactMap(\.startedAt).max() ?? .distantPast }
    var updatedAt: Date { tasks.compactMap { $0.finishedAt ?? $0.updatedAt ?? $0.startedAt }.max() ?? .distantPast }
}

/// How the agent profile's Activity tab lays out tasks: live ones first, then the finished ones grouped by day (Today, Yesterday,
/// then the date), newest first, capped. Tasks group by `parentId`; routine runs gather under their routine.
enum TaskGroups {
    struct Day: Equatable { var title: String; var entries: [TaskEntry] }
    struct Layout: Equatable {
        var active: [TaskEntry]
        var days: [Day]
        /// How many finished entries exist in total (for "Show more").
        var finishedTotal: Int
    }

    static func isActive(_ task: Contract.AgentTask) -> Bool { task.status != "ended" }

    /// Group by `parentId`: a task whose parent is not in the list is top-level. A parent is found by task id, by the run a
    /// subagent is (`childRunId`) or by the run a routine task is (`runId`). Children are oldest first.
    static func tree(_ tasks: [Contract.AgentTask]) -> [TaskNode] {
        func keys(_ t: Contract.AgentTask) -> [String] { [t.id, t.childRunId, t.kind == "routine" ? t.runId : nil].compactMap { $0 } }
        var byKey: [String: Int] = [:]
        for (i, t) in tasks.enumerated() { for key in keys(t) { byKey[key] = i } }
        var children: [Int: [Int]] = [:]
        var top: [Int] = []
        for (i, t) in tasks.enumerated() {
            if let parent = t.parentId.flatMap({ byKey[$0] }), parent != i { children[parent, default: []].append(i) } else { top.append(i) }
        }
        func node(_ i: Int, _ seen: inout Set<Int>) -> TaskNode {
            seen.insert(i)
            let kids = (children[i] ?? []).filter { !seen.contains($0) }
                .sorted { (tasks[$0].startedAt ?? .distantPast) < (tasks[$1].startedAt ?? .distantPast) }
            return TaskNode(task: tasks[i], children: kids.map { node($0, &seen) })
        }
        var seen = Set<Int>()
        var nodes = top.map { node($0, &seen) }
        // Tasks that point at each other in a loop never reach the top; show them there rather than lose them.
        for i in tasks.indices where !seen.contains(i) { nodes.append(node(i, &seen)) }
        return nodes
    }

    /// Routine runs gather under their routine (at the first run's position); everything else stays a task entry.
    static func entries(_ tasks: [Contract.AgentTask]) -> [TaskEntry] {
        var entries: [TaskEntry] = []
        var routineAt: [String: Int] = [:]
        for node in tree(tasks) {
            guard node.task.kind == "routine", let routineId = node.task.routineId else { entries.append(.task(node)); continue }
            if let at = routineAt[routineId], case .routine(let id, let runs) = entries[at] {
                entries[at] = .routine(id: id, runs: runs + [node])
            } else {
                routineAt[routineId] = entries.count
                entries.append(.routine(id: routineId, runs: [node]))
            }
        }
        return entries
    }

    static func layout(_ tasks: [Contract.AgentTask], limit: Int, now: Date = Date(), calendar: Calendar = .current) -> Layout {
        let all = entries(tasks)
        let active = all.filter(\.isLive).sorted { $0.startedAt > $1.startedAt }
        let finished = all.filter { !$0.isLive }.sorted { $0.updatedAt > $1.updatedAt }
        var days: [Day] = []
        for entry in finished.prefix(limit) {
            let date = entry.updatedAt
            let title = calendar.isDate(date, inSameDayAs: now) ? "Today"
                : calendar.isDate(date, inSameDayAs: calendar.date(byAdding: .day, value: -1, to: now) ?? now) ? "Yesterday"
                : date.formatted(.dateTime.day().month(.abbreviated))
            if days.last?.title == title { days[days.count - 1].entries.append(entry) } else { days.append(Day(title: title, entries: [entry])) }
        }
        return Layout(active: active, days: days, finishedTotal: finished.count)
    }
}
