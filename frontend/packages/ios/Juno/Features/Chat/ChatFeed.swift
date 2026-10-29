import Foundation
import SwiftUI

/// One row of the chat list: a transcript item or the typing row. `id` is stable across updates, so the list
/// reconfigures a changed row in place instead of removing and inserting it.
struct ChatEntry: Identifiable, Equatable {
    let id: String
    var item: Item?
    /// Set on the typing row: the run it stands for.
    var typingRunId: String?
    /// Set on the first item of a day: the date separator drawn above it.
    var dayStart: Date?
    /// Part of a run of consecutive messages from one agent reply (one message per paragraph): the author shows once
    /// and the gap between them is tight, like several texts in a row. `continuesGroup` marks every message after the
    /// first, `groupContinues` every message before the last.
    var continuesGroup = false
    var groupContinues = false
    /// Everything besides the item that decides how the row lays out (its run, request, file, reaction, send state):
    /// the row's height is measured again when it changes, and only then.
    var revision = 0
}

/// Maps Juno's transcript onto list entries: one per transcript item, stable ids.
@MainActor
enum ChatFeed {
    /// While the agent's run is active, the last row is a typing row, under interim replies too.
    /// A sent message keeps the local id it was shown under when the server's item replaces it (`displayIds`).
    static func entries(world: World, conversationId: String, items rawItems: [Item]) -> [ChatEntry] {
        let items = feedRefsAfterReply(rawItems)
        let isGroup = world.conversation(conversationId)?.kind == "room"
        let run = world.activeRuns(in: conversationId).first {
            $0.parentRunId == nil && ["running", "queued"].contains($0.status ?? "")
        }
        let days = DateSeparator.dayStarts(items)

        var result: [ChatEntry] = []
        var seen = Set<String>()
        for item in items {
            // The only run row is a failed or stopped task with no reply; live work is the typing row and the
            // composer's Stop, finished work is the footer under the reply.
            if item.type == "run", !World.isFailedRunRow(world.run(item.runId)) { continue }
            // A row whose data has not arrived yet (its request, file or routine) joins when it does, at its final size,
            // instead of appearing empty and growing.
            if !hasData(item, world: world) { continue }
            let id = world.displayIds[item.id] ?? item.id
            guard seen.insert(id).inserted else { continue }
            var entry = ChatEntry(id: id, item: item, dayStart: days[item.id],
                                  revision: revision(item, day: days[item.id], isGroup: isGroup, world: world))
            if days[item.id] == nil, let previous = result.last?.item, sameReply(previous, item) {
                entry.continuesGroup = true
                result[result.count - 1].groupContinues = true
            }
            result.append(entry)
        }
        // The grouping flags change a row's height, so they are part of its revision.
        for index in result.indices where result[index].continuesGroup || result[index].groupContinues {
            var h = Hasher()
            h.combine(result[index].revision); h.combine(result[index].continuesGroup); h.combine(result[index].groupContinues)
            result[index].revision = h.finalize()
        }
        // The dots mean "working": while the run waits for the user, its request card is inline and the chat shows neither.
        // A question or connect card never pauses the run (it stays open until answered), so it does not hide them.
        let waiting = world.pending(in: conversationId).contains { $0.flavor != .question && $0.flavor != .connect }
        // The typing bubble is the only working indicator: from send until the run ends, under the newest message
        // (interim replies included); it returns when a waiting run resumes. Tapping it opens the Activity sheet.
        if let run, !waiting {
            result.append(ChatEntry(id: "typing-\(run.id)", typingRunId: run.id))
        }
        return result
    }

    /// Two agent messages of one agent's one run: the paragraphs of a single reply.
    private static func sameReply(_ a: Item, _ b: Item) -> Bool {
        a.type == "agent_message" && b.type == "agent_message" && a.runId != nil && a.runId == b.runId && a.agentId == b.agentId
    }

    /// "Posted to Feed" cards read after the run's final reply: each `feed_ref` moves right behind the last agent
    /// message of its run (it stays where it is when the run has no later agent message).
    static func feedRefsAfterReply(_ items: [Item]) -> [Item] {
        var lastReply: [String: Int] = [:]
        for (index, item) in items.enumerated() where item.type == "agent_message" {
            if let run = item.runId { lastReply[run] = index }
        }
        var moved: [Int: [Item]] = [:]
        var rest: [(Int, Item)] = []
        for (index, item) in items.enumerated() {
            if item.type == "feed_ref", let run = item.runId, let at = lastReply[run], at > index { moved[at, default: []].append(item) }
            else { rest.append((index, item)) }
        }
        if moved.isEmpty { return items }
        return rest.flatMap { [$0.1] + (moved[$0.0] ?? []) }
    }

    /// Runs that posted to the Feed: their replies' sources belong to the post, not the chat.
    static func postedRuns(_ items: [Item]) -> Set<String> {
        Set(items.compactMap { $0.type == "feed_ref" ? $0.runId : nil })
    }

    /// Cards that render from another list: nothing to show until that list has the record.
    private static func hasData(_ item: Item, world: World) -> Bool {
        switch item.type {
        case "run": world.run(item.runId) != nil
        case "request": world.request(item.requestId) != nil
        case "artifact": world.file(item.artifactId) != nil
        case "routine": world.routine(item.routineId) != nil
        default: true
        }
    }

    static func hidesSources(_ item: Item, world: World) -> Bool {
        guard let run = item.runId, let conversationId = item.conversationId else { return false }
        return postedRuns(world.items[conversationId] ?? []).contains(run)
    }

    private static func revision(_ item: Item, day: Date?, isGroup: Bool, world: World) -> Int {
        var h = Hasher()
        h.combine(item)
        h.combine(day)
        h.combine(isGroup)
        h.combine(world.reactions[item.id])
        h.combine(world.outbox[item.id])
        switch item.type {
        case "user_message": if isGroup { h.combine(world.member(item.authorId)?.name) }
        case "agent_message":
            if isGroup { h.combine(world.agent(item.agentId)?.name) }
            h.combine(hidesSources(item, world: world))
            h.combine(world.repliesOpen(item))
        case "run":
            if let run = world.run(item.runId) { h.combine(run.status); h.combine(run.error) }
        case "plan": h.combine(world.run(item.runId)?.title)
        case "request": h.combine(world.request(item.requestId))
        case "artifact": h.combine(world.file(item.artifactId))
        case "routine": h.combine(world.routine(item.routineId))
        case "handoff", "role_suggestion":
            let agent = world.agent(item.agentId ?? world.conversation(item.conversationId)?.agentIds?.first)
            h.combine(agent?.name); h.combine(agent?.roleSuggestion); h.combine(agent?.roleSuggestionDismissedAt)
            h.combine(world.agent(item.toAgentId)?.name)
        default: break
        }
        return h.finalize()
    }
}

/// The reply slot while the agent has not produced text yet: an iMessage-style three-dot bubble in the agent's
/// colours. It is the only working indicator; tapping it opens the run's Activity sheet.
struct ChatTypingRow: View {
    @Environment(World.self) private var world
    var conversationId: String
    var runId: String

    var body: some View {
        Button { world.sheet = .runSteps(runId) } label: {
            TimelineView(.animation(minimumInterval: 0.2)) { context in
                let t = context.date.timeIntervalSinceReferenceDate
                HStack(spacing: 4) {
                    ForEach(0..<3, id: \.self) { i in
                        Circle().fill(Theme.bubbleAgentFg)
                            .frame(width: 7, height: 7)
                            .opacity(0.3 + 0.7 * (0.5 + 0.5 * sin(t * 5 - Double(i) * 1.2)))
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 11)
                .background(Theme.bubbleAgent, in: .rect(cornerRadius: Radius.xxl))
                .contentShape(.rect(cornerRadius: Radius.xxl))
            }
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityLabel("Show what the agent is doing")
        .accessibilityIdentifier("typing-bubble")
    }
}
