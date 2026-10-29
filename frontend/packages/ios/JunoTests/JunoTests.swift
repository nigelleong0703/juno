import XCTest
import SwiftUI
@testable import Juno

// Characterization tests: they pin what the app does today (fast, no network, no UI).

// MARK: - Agent zoom source

/// The zoom out of an avatar needs the copy of the avatar that is on screen. A second copy that was registered later
/// (UIKit keeps one while a navigation-bar item transitions) must not hide it, or the agent page falls back to a plain
/// slide up from the bottom.
@MainActor
final class AgentZoomSourcesTests: XCTestCase {
    func testOnScreenCopyWinsOverNewerDetachedOne() {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        let onScreen = UIView(), detached = UIView()
        window.addSubview(onScreen)
        AgentZoomSources.register("t-chat", onScreen)
        AgentZoomSources.register("t-chat", detached)
        XCTAssertTrue(AgentZoomSources.view(for: "t-chat") === onScreen)
        window.addSubview(detached)
        XCTAssertTrue(AgentZoomSources.view(for: "t-chat") === detached, "the newest copy in a window is the source")
        detached.removeFromSuperview()
        XCTAssertTrue(AgentZoomSources.view(for: "t-chat") === onScreen)
        onScreen.removeFromSuperview()
        XCTAssertNil(AgentZoomSources.view(for: "t-chat"))
    }
}

// MARK: - SSELines

private struct ByteStream: AsyncSequence {
    typealias Element = UInt8
    var bytes: [UInt8]
    struct AsyncIterator: AsyncIteratorProtocol {
        var bytes: [UInt8]; var i = 0
        mutating func next() async -> UInt8? { defer { i += 1 }; return i < bytes.count ? bytes[i] : nil }
    }
    func makeAsyncIterator() -> AsyncIterator { AsyncIterator(bytes: bytes) }
}

final class SSELinesTests: XCTestCase {
    private func lines(_ s: String) async throws -> [String] {
        var out: [String] = []
        for try await l in SSELines(bytes: ByteStream(bytes: Array(s.utf8))) { out.append(l) }
        return out
    }

    func testKeepsEmptyLinesThatEndEvents() async throws {
        let got = try await lines("id: 1\ndata: {}\n\nid: 2\ndata: {}\n\n")
        XCTAssertEqual(got, ["id: 1", "data: {}", "", "id: 2", "data: {}", ""])
    }

    func testStripsCarriageReturn() async throws {
        let got = try await lines("data: a\r\n\r\ndata: b\r\n")
        XCTAssertEqual(got, ["data: a", "", "data: b"])
    }

    func testTrailingPartialLineIsEmitted() async throws {
        let got = try await lines("data: a\ndata: b")
        XCTAssertEqual(got, ["data: a", "data: b"])
    }

    func testEmptyStreamYieldsNothing() async throws {
        let got = try await lines("")
        XCTAssertEqual(got, [])
    }

    func testMultibyteSplitsOnlyAtNewline() async throws {
        let got = try await lines("data: héllo 你好\n")
        XCTAssertEqual(got, ["data: héllo 你好"])
    }
}

// MARK: - World

@MainActor
final class WorldTests: XCTestCase {
    private func world() -> World {
        let w = World()
        w.agents = [Agent(id: "a1", name: "Milo", status: "idle"), Agent(id: "a2", name: "Ada")]
        w.conversations = [Conversation(id: "c1", kind: "direct", agentIds: ["a1"])]
        w.items = ["c1": []]
        return w
    }

    private func frame(_ json: String) -> Data { Data(json.utf8) }

    func testTypingDotsOnlyWhileTheAgentIsWorking() {
        let w = world()
        // Just started, nothing to show yet: the dots.
        let t0 = Date()
        w.runs = [Run(id: "r1", conversationId: "c1", status: "running", startedAt: t0)]
        w.items["c1"] = [Item(id: "u1", conversationId: "c1", at: t0, type: "user_message", text: "buy it")]
        func entries() -> [ChatEntry] { ChatFeed.entries(world: w, conversationId: "c1", items: w.items["c1"] ?? []) }
        func typing() -> Bool { entries().contains { $0.typingRunId != nil } }
        XCTAssertTrue(typing())
        // An open question or connect card never pauses the run, so the dots stay (63eba77: a card left open silenced
        // every later reply).
        w.requests = [AgentRequest(id: "q1", kind: "question", status: "pending", conversationId: "c1", runId: "r1", createdAt: t0)]
        XCTAssertTrue(typing())
        w.requests[0].status = "answered"
        XCTAssertTrue(typing())
        // A long run (many steps, well past 8s) still shows only the bubble: there is no status row.
        var long = Run(id: "r1", conversationId: "c1", status: "running", startedAt: t0.addingTimeInterval(-300))
        long.steps = (1...3).map { Step(id: "s\($0)", index: $0, kind: "mcp", verb: "Looked up", target: "web_search", input: StepInput(summary: #"{"query":"q\#($0)"}"#)) }
        w.runs = [long]
        XCTAssertTrue(typing())
        XCTAssertEqual(entries().filter { $0.typingRunId != nil }.count, 1)
        // An approval waits: its card is inline and the bubble goes.
        w.requests = [AgentRequest(id: "a1", kind: "approval", status: "pending", conversationId: "c1", runId: "r1", createdAt: t0)]
        XCTAssertFalse(typing())
        // It resumes after the approval; an interim reply does not end the bubble, which stays last under it.
        w.requests[0].status = "approved"
        w.items["c1"]?.append(Item(id: "m1", conversationId: "c1", at: t0.addingTimeInterval(5), type: "agent_message", markdown: "On it, checking prices", runId: "r1"))
        XCTAssertTrue(typing())
        XCTAssertEqual(entries().last?.typingRunId, "r1")
        XCTAssertEqual(entries().filter { $0.typingRunId != nil }.count, 1)
        // The run ends: no bubble.
        var done = long; done.status = "completed"
        w.runs = [done]
        XCTAssertFalse(typing())
    }

    func testOnlyAFailedRunGetsATranscriptRow() {
        let w = world()
        let t0 = Date(timeIntervalSince1970: 1_000)
        var worked = Run(id: "r1", conversationId: "c1", status: "completed", usage: RunUsage(costUsd: nil, steps: 9), startedAt: t0, finishedAt: t0.addingTimeInterval(480), durationMs: 480_000)
        // Four searches the user can tell apart (visibleSteps collapses a step that reads like the one before it).
        worked.steps = (1...4).map { Step(id: "s\($0)", index: $0, kind: "mcp", verb: "Looked up", target: "web_search", input: StepInput(summary: #"{"query":"q\#($0)"}"#)) }
        w.runs = [worked, Run(id: "r2", conversationId: "c1", status: "failed", startedAt: t0.addingTimeInterval(600))]
        w.items["c1"] = [
            Item(id: "u1", conversationId: "c1", at: t0, type: "user_message", text: "do it"),
            Item(id: "m1", conversationId: "c1", at: t0.addingTimeInterval(10), type: "agent_message", markdown: "a", runId: "r1"),
            Item(id: "m2", conversationId: "c1", at: t0.addingTimeInterval(20), type: "agent_message", markdown: "b", runId: "r1"),
            Item(id: "u2", conversationId: "c1", at: t0.addingTimeInterval(599), type: "user_message", text: "again"),
        ]
        XCTAssertEqual(w.triggerMessage(of: w.runs[1])?.id, "u2")
        // The completed run adds no row; the failed one without a reply does.
        XCTAssertEqual(w.transcript("c1").filter { $0.type == "run" }.map(\.runId), ["r2"])
    }

    func testActivityTitleIsTheRunsOwnOrTheMessageThatStartedIt() {
        XCTAssertEqual(World.taskTitle(runTitle: "Book the flights", trigger: "hi"), "Book the flights")
        // The generic placeholder never shows: the person's message (first line, truncated) stands in.
        XCTAssertEqual(World.taskTitle(runTitle: "Task", trigger: "Find me a flat\nunder 2k"), "Find me a flat")
        XCTAssertEqual(World.taskTitle(runTitle: nil, trigger: String(repeating: "a", count: 80)), String(repeating: "a", count: 60) + "\u{2026}")
        XCTAssertNil(World.taskTitle(runTitle: "Task", trigger: nil))
    }

    func testStepsTheBackendMarksInternalAreHiddenAndOthersReadAsWords() {
        func step(_ target: String, verb: String = "Executed", plumbing: Bool? = nil) -> Step {
            Step(id: target, index: 0, kind: "mcp", verb: verb, target: target, internal: plumbing)
        }
        let steps = ["tool_search", "skill_read", "todo_write"].map { step($0, plumbing: true) } + [step("github_create_issue")]
        XCTAssertEqual(visibleSteps(steps).map(\.target), ["github_create_issue"])
        XCTAssertEqual(stepLine(step("github_create_issue"))?.text, "Github create issue")
        // The app keeps no list of tool names: an unflagged step shows whatever it is called.
        XCTAssertEqual(stepLine(step("tool_search"))?.text, "Tool search")
    }

    func testControlChangedKeepsTheNewestEpochAndTheMacStopLiftsOnlyWithALaterResume() {
        let w = world()
        func screenEvent(_ holder: String, _ epoch: Int) -> Data {
            frame(#"{"type":"control.changed","ownerId":"o","surface":{"kind":"screen","screenId":"s1"},"holder":"\#(holder)","epoch":\#(epoch),"since":"2026-10-29T10:00:00Z","phase":"taken"}"#)
        }
        func macEvent(_ holder: String, _ epoch: Int) -> Data {
            frame(#"{"type":"control.changed","ownerId":"o","surface":{"kind":"mac","macId":"m1"},"holder":"\#(holder)","epoch":\#(epoch),"since":"2026-10-29T10:00:00Z","phase":"stopped"}"#)
        }
        w.apply(screenEvent("user", 5))
        w.apply(screenEvent("agent", 4))
        XCTAssertEqual(w.controlEpochs["s1"], 5, "a replayed older event changes nothing")

        w.myMac = Contract.MacStatus(paired: true, online: true)
        w.apply(macEvent("stopped", 2))
        XCTAssertEqual(w.myMac?.stopped?.epoch, 2)
        w.apply(macEvent("agent", 1))
        XCTAssertNotNil(w.myMac?.stopped, "an older resume does not lift the stop")
        w.apply(macEvent("agent", 3))
        XCTAssertNil(w.myMac?.stopped)
    }

    func testAnApprovalRefusedAsExpiredReadsExpiredNotFailed() {
        let w = world()
        w.requests = [AgentRequest(id: "a1", kind: "approval", status: "approved", agentId: "a1")]
        XCTAssertTrue(World.isExpiredApproval(APIError.api(status: 409, code: "REQUEST_EXPIRED", message: "expired")))
        XCTAssertFalse(World.isExpiredApproval(APIError.api(status: 409, code: "REQUEST_NOT_PENDING", message: "")))
        w.markExpired("a1")
        XCTAssertEqual(w.requests.first?.status, "expired")
        XCTAssertEqual(w.requests.first?.outcome, "timed_out")
    }

    func testTaskWordingSaysWhoStoppedIt() throws {
        func ended(_ detail: String?) throws -> Contract.AgentTask {
            let extra = detail.map { #","outcomeDetail":"\#($0)""# } ?? ""
            return try isoDecoder.decode(Contract.AgentTask.self, from: Data(#"{"id":"t","kind":"task","agentId":"a1","rootRunId":"r","depth":0,"origin":{"type":"owner_message"},"mode":"background","replyTo":{"type":"none"},"status":"ended","outcome":"cancelled","title":"t","startedAt":"2026-10-29T08:00:00Z","updatedAt":"2026-10-29T08:00:00Z"\#(extra)}"#.utf8))
        }
        XCTAssertEqual(TaskWords.subtitle(try ended("stopped_by_owner")), "Stopped by you")
        XCTAssertEqual(TaskWords.subtitle(try ended("stopped_by_agent"), agentName: "Juno"), "Stopped by Juno")
        XCTAssertEqual(TaskWords.subtitle(try ended("stopped_by_agent")), "Stopped by the agent")
        XCTAssertEqual(TaskWords.subtitle(try ended("stopped_by_system")), "Stopped automatically")
        XCTAssertEqual(TaskWords.subtitle(try ended(nil)), "Stopped")
    }

    func testRunEventKeepsReceivedSteps() {
        let w = world()
        w.apply(frame(#"{"type":"RUN_STARTED","threadId":"c1","runId":"wire-1","metadata":{"juno":{"agentId":"a1","conversationId":"c1","runId":"r1"}}}"#))
        w.apply(frame(#"{"type":"STEP_STARTED","stepName":"Search","metadata":{"juno":{"runId":"r1","stepId":"s1"}}}"#))
        w.apply(frame(#"{"type":"RUN_FINISHED","threadId":"c1","runId":"wire-1","outcome":{"type":"success"},"metadata":{"juno":{"agentId":"a1","conversationId":"c1","runId":"r1","runStatus":"completed"}}}"#))
        XCTAssertEqual(w.runs.first?.steps?.count, 1,"a terminal run without a steps field must retain steps already received")
    }

    func testRunLifecycleUpserts() {
        let w = world()
        w.apply(frame(#"{"type":"RUN_STARTED","threadId":"c1","runId":"wire-1","metadata":{"juno":{"agentId":"a1","conversationId":"c1","runId":"r1"}}}"#))
        XCTAssertEqual(w.runs.map(\.id), ["r1"])
        XCTAssertEqual(w.runs.first?.status, "running")
        w.apply(frame(#"{"type":"CUSTOM","name":"juno.run.updated","value":{"id":"r1","agentId":"a1","conversationId":"c1","status":"running","title":"Do it now","kind":"chat"}}"#))
        XCTAssertEqual(w.runs.count, 1)
        XCTAssertEqual(w.runs.first?.title, "Do it now")
        w.apply(frame(#"{"type":"RUN_FINISHED","threadId":"c1","runId":"wire-1","outcome":{"type":"success"},"metadata":{"juno":{"agentId":"a1","conversationId":"c1","runId":"r1","runStatus":"completed"}}}"#))
        XCTAssertEqual(w.runs.count, 1)
        XCTAssertEqual(w.runs.first?.status, "completed")
    }

    func testItemAddedDedupesAndIgnoresUnloadedChats() {
        let w = world()
        let f = frame(#"{"type":"item.added","conversationId":"c1","item":{"id":"i1","type":"user_message","text":"hi"}}"#)
        w.apply(f); w.apply(f)
        XCTAssertEqual(w.items["c1"]?.map(\.id), ["i1"])
        w.apply(frame(#"{"type":"item.added","conversationId":"other","item":{"id":"i2","text":"x"}}"#))
        XCTAssertNil(w.items["other"])
    }

    func testAgentUpdatedUpsertsAndStatusSetsDoing() {
        let w = world()
        w.apply(frame(#"{"type":"agent.updated","agent":{"id":"a1","name":"Milo 2"}}"#))
        XCTAssertEqual(w.agent("a1")?.name, "Milo 2")
        w.apply(frame(#"{"type":"agent.updated","agent":{"id":"a3","name":"New"}}"#))
        XCTAssertEqual(w.agents.count, 3)
        w.apply(frame(#"{"type":"agent.status","agentId":"a1","status":"working","doing":"Reading"}"#))
        XCTAssertEqual(w.agent("a1")?.status, "working")
        XCTAssertEqual(w.doing["a1"], "Reading")
        w.apply(frame(#"{"type":"agent.status","agentId":"a1","status":"idle"}"#))
        XCTAssertEqual(w.agent("a1")?.status, "idle")
        XCTAssertNil(w.doing["a1"])
    }

    func testConversationUpdatedAndDeleted() {
        let w = world()
        w.apply(frame(#"{"type":"conversation.updated","conversation":{"id":"c1","kind":"direct","lastMessagePreview":"hello","agentIds":["a1"]}}"#))
        XCTAssertEqual(w.conversations.count, 1)
        XCTAssertEqual(w.conversation("c1")?.lastMessagePreview, "hello")
        w.apply(frame(#"{"type":"conversation.deleted","conversationId":"c1"}"#))
        XCTAssertTrue(w.conversations.isEmpty)
    }

    func testUnknownAndMalformedFramesAreIgnored() {
        let w = world()
        w.apply(frame(#"{"type":"nope"}"#))
        w.apply(frame("not json"))
        XCTAssertEqual(w.agents.count, 2)
    }

    func testSendWithoutBackendAppendsOptimisticItem() {
        let w = world()
        w.send("hello", in: "c1")
        let item = w.items["c1"]?.last
        XCTAssertEqual(item?.text, "hello")
        XCTAssertEqual(item?.type, "user_message")
        XCTAssertEqual(item?.authorId, w.selfId)
        XCTAssertEqual(w.conversation("c1")?.lastMessagePreview, "hello")
        XCTAssertNotNil(w.conversation("c1")?.lastItemAt)
        XCTAssertTrue(w.outbox.isEmpty, "no backend: nothing is pending")
    }

    func testSendCarriesAttachments() {
        let w = world()
        let file = Attachment(id: "f1", name: "a.png")
        w.send("see", in: "c1", files: [file])
        XCTAssertEqual(w.items["c1"]?.last?.attachments, [file])
    }

    func testRetryResendsAtTheEndAndDiscardRemoves() {
        let w = world()
        w.send("one", in: "c1")
        w.send("two", in: "c1")
        let first = w.items["c1"]![0].id
        w.outbox[first] = .some("offline")
        w.retry(first, in: "c1")
        XCTAssertEqual(w.items["c1"]?.compactMap(\.text), ["two", "one"])
        XCTAssertNil(w.outbox[first] ?? nil)
        XCTAssertEqual(w.items["c1"]?.last?.id, first, "retry keeps its stable wire identity while moving to the queue tail")
        XCTAssertEqual(Set(w.items["c1"]?.map(\.id) ?? []).count, 2)
        let last = w.items["c1"]![1].id
        w.outbox[last] = .some("offline")
        w.discard(last, in: "c1")
        XCTAssertEqual(w.items["c1"]?.compactMap(\.text), ["two"])
        XCTAssertTrue(w.outbox.isEmpty)
    }

    func testDoingLine() {
        let w = world()
        XCTAssertEqual(w.doingLine(w.agent("a1")!), "Free")
        w.agents[0].lastActivity = "Wrote a note"
        XCTAssertEqual(w.doingLine(w.agent("a1")!), "Wrote a note")
        // A run still titled with the owner's message is never shown; the agent's own summary or title is.
        w.runs = [Run(id: "r1", agentId: "a1", title: "Old task", status: "completed", startedAt: Date(timeIntervalSince1970: 100))]
        XCTAssertEqual(w.doingLine(w.agent("a1")!), "Wrote a note")
        w.runs[0].summary = "Sorted the inbox"
        XCTAssertEqual(w.doingLine(w.agent("a1")!), "Sorted the inbox")
        w.runs[0].titleGenerated = true
        XCTAssertEqual(w.doingLine(w.agent("a1")!), "Old task")
        w.runs.append(Run(id: "r2", agentId: "a1", title: "? Any other tool?", status: "running", startedAt: Date(timeIntervalSince1970: 200)))
        XCTAssertEqual(w.doingLine(w.agent("a1")!), "Working on it", "the owner's message is not what the agent is doing")
        w.doing["a1"] = "? Any other tool?"
        XCTAssertEqual(w.doingLine(w.agent("a1")!), "Working on it", "the server's fallback to the raw title is dropped too")
        w.runs[1].title = "Comparing tools"
        w.runs[1].titleGenerated = true
        w.doing["a1"] = nil
        XCTAssertEqual(w.doingLine(w.agent("a1")!), "Comparing tools")
        w.runs[1].titleGenerated = nil
        w.doing["a1"] = "Planned line"
        XCTAssertEqual(w.doingLine(w.agent("a1")!), "Planned line")
        w.requests = [AgentRequest(id: "q1", status: "pending", agentId: "a1")]
        XCTAssertEqual(w.doingLine(w.agent("a1")!), "Planned line", "a planned doing text wins over waiting")
        w.doing["a1"] = nil
        XCTAssertEqual(w.doingLine(w.agent("a1")!), "Waiting on you")
    }

    func testDoingLineSkipsInternalWakeNotes() {
        let w = world()
        let note = "[system note, from the user's tap on a card] The user approved \"Agent directory\", which you stopped waiting for."
        w.agents[0].lastActivity = "Checked the list"
        w.runs = [Run(id: "r1", agentId: "a1", title: note, status: "completed", startedAt: Date(timeIntervalSince1970: 100))]
        XCTAssertEqual(w.doingLine(w.agent("a1")!), "Checked the list")
        XCTAssertTrue(World.isInternalNote(note))
        XCTAssertFalse(World.isInternalNote("Summarize the [system] folder"))
    }

    func testIsWorking() {
        let w = world()
        XCTAssertFalse(w.isWorking("a1"))
        w.runs = [Run(id: "r1", agentId: "a1", status: "blocked")]
        XCTAssertFalse(w.isWorking("a1"), "blocked is not working")
        w.runs = [Run(id: "r1", agentId: "a1", status: "waiting_for_input")]
        XCTAssertFalse(w.isWorking("a1"))
        w.runs = [Run(id: "r1", agentId: "a1", status: "queued")]
        XCTAssertTrue(w.isWorking("a1"))
        w.runs = [Run(id: "r1", agentId: "a1", status: "running", parentRunId: "r0")]
        XCTAssertFalse(w.isWorking("a1"), "child runs don't count")
        w.runs = [Run(id: "r1", agentId: "a1", status: "running")]
        XCTAssertTrue(w.isWorking("a1"))
        XCTAssertFalse(w.isWorking("a2"))
    }

    func testOpenChatSelectsChatAndClosesChrome() {
        let w = world()
        w.sidebarOpen = true
        w.conversations[0].unreadCount = 3
        w.openChat("c1", draft: "prefill")
        XCTAssertEqual(w.tab, "chat")
        XCTAssertEqual(w.currentConversationId, "c1")
        XCTAssertFalse(w.sidebarOpen)
        XCTAssertEqual(w.drafts["c1"], "prefill")
        XCTAssertEqual(w.conversation("c1")?.unreadCount, 0)
    }

    @MainActor func testFeedRefReadsAfterTheRunsFinalReply() {
        let t = Date(timeIntervalSince1970: 0)
        func reply(_ id: String, _ run: String) -> Item { Item(id: id, conversationId: "c1", at: t, type: "agent_message", markdown: id, runId: run) }
        func ref(_ id: String, _ run: String?) -> Item { Item(id: id, conversationId: "c1", at: t, type: "feed_ref", runId: run) }
        let items = [reply("lead", "r1"), ref("card", "r1"), reply("final", "r1"), reply("other", "r2")]
        XCTAssertEqual(ChatFeed.feedRefsAfterReply(items).map(\.id), ["lead", "final", "card", "other"])
        let stay = [reply("lead", "r1"), ref("card", "r1"), ref("loose", nil)]
        XCTAssertEqual(ChatFeed.feedRefsAfterReply(stay).map(\.id), ["lead", "card", "loose"])
        XCTAssertEqual(ChatFeed.postedRuns(items), ["r1"])
    }
}

// MARK: - Quote, DateSeparator

final class QuoteTests: XCTestCase {
    func testSplitPlainTextHasNoQuote() {
        let r = Quote.split("hello\nworld")
        XCTAssertNil(r.quote)
        XCTAssertEqual(r.body, "hello\nworld")
    }

    func testSplitLeadingQuoteBlock() {
        let r = Quote.split("> first\n> second\n\nreply text\nmore")
        XCTAssertEqual(r.quote, "first\nsecond")
        XCTAssertEqual(r.body, "reply text\nmore")
    }

    func testQuoteWithoutSpaceAndOnlyLeading() {
        let r = Quote.split(">tight\nbody\n> not a quote")
        XCTAssertEqual(r.quote, "tight")
        XCTAssertEqual(r.body, "body\n> not a quote")
    }

    func testPrefixQuotesAndTruncates() {
        XCTAssertEqual(Quote.prefix(for: Item(id: "i", text: "a\nb")), "> a\n> b\n\n")
        let long = String(repeating: "x", count: 200)
        XCTAssertEqual(Quote.prefix(for: Item(id: "i", text: long)), "> " + String(repeating: "x", count: 140) + "…\n\n")
    }

    func testPrefixDropsNestedQuoteOfTheSource() {
        XCTAssertEqual(Quote.prefix(for: Item(id: "i", text: "> old\n\nnew")), "> new\n\n")
    }

    func testPrefixFallsBackToMarkdown() {
        XCTAssertEqual(Quote.prefix(for: Item(id: "i", markdown: "md")), "> md\n\n")
    }
}

final class DateSeparatorTests: XCTestCase {
    func testDayStartsMarksFirstItemOfEachDay() {
        let cal = Calendar.current
        let d1 = cal.date(from: DateComponents(year: 2026, month: 3, day: 1, hour: 9))!
        let d1b = cal.date(from: DateComponents(year: 2026, month: 3, day: 1, hour: 18))!
        let d2 = cal.date(from: DateComponents(year: 2026, month: 3, day: 2, hour: 8))!
        let items = [Item(id: "a", at: d1), Item(id: "b", at: d1b), Item(id: "c"), Item(id: "d", at: d2)]
        let starts = DateSeparator.dayStarts(items)
        XCTAssertEqual(Set(starts.keys), ["a", "d"])
        XCTAssertEqual(starts["a"], d1)
        XCTAssertEqual(starts["d"], d2)
    }

    func testDayStartsEmpty() {
        XCTAssertTrue(DateSeparator.dayStarts([]).isEmpty)
    }

    func testLabelTodayAndYesterday() {
        XCTAssertEqual(DateSeparator.label(Date()), "Today")
        XCTAssertEqual(DateSeparator.label(Calendar.current.date(byAdding: .day, value: -1, to: Date())!), "Yesterday")
    }
}

// MARK: - Fmt, role suggestion

final class FmtTests: XCTestCase {
    func testRunErrorMapsServiceFailures() {
        XCTAssertTrue(Fmt.runError("model failed (402) {\"error\":1}").hasPrefix("The model service is out of credit"))
        XCTAssertTrue(Fmt.runError("Insufficient balance").hasPrefix("The model service is out of credit"))
        XCTAssertTrue(Fmt.runError("bad (401)").hasPrefix("The model service rejected the key"))
        XCTAssertTrue(Fmt.runError("bad (403)").hasPrefix("The model service rejected the key"))
        XCTAssertTrue(Fmt.runError("slow (429)").hasPrefix("The model service is busy"))
    }

    func testRunErrorKeepsFirstLineWithoutJSON() {
        XCTAssertEqual(Fmt.runError("Tool crashed: {\"code\":1}\nstack"), "Tool crashed")
        XCTAssertEqual(Fmt.runError("plain failure\nmore"), "plain failure")
    }

    func testTime() {
        XCTAssertEqual(Fmt.time(nil), "")
        let d = Calendar.current.date(from: DateComponents(year: 2026, month: 1, day: 1, hour: 9, minute: 5))!
        XCTAssertEqual(Fmt.time(d), d.formatted(date: .omitted, time: .shortened))
        XCTAssertTrue(Fmt.time(d).contains("5"))
    }

    func testDuration() {
        XCTAssertEqual(Fmt.duration(nil), "")
        XCTAssertEqual(Fmt.duration(0), "1s")
        XCTAssertEqual(Fmt.duration(45_000), "45s")
        XCTAssertEqual(Fmt.duration(125_000), "2m")
        XCTAssertEqual(Fmt.duration(3_725_000), "1h 2m")
    }
}

final class RoleSuggestionRuleTests: XCTestCase {
    private let t = Date(timeIntervalSince1970: 1_000)

    func testPendingWhileAgentHoldsThisSuggestion() {
        var a = Agent(id: "a", title: "Agent", roleSuggestion: RoleSuggestion(title: "Researcher", createdAt: t))
        XCTAssertTrue(RoleSuggestionRule.isPending(agent: a, suggestionAt: t))
        XCTAssertTrue(RoleSuggestionRule.isPending(agent: a, suggestionAt: t.addingTimeInterval(0.5)))
        XCTAssertFalse(RoleSuggestionRule.isPending(agent: a, suggestionAt: t.addingTimeInterval(5)), "a newer suggestion")
        XCTAssertFalse(RoleSuggestionRule.isPending(agent: a, suggestionAt: nil))
        a.roleSuggestion = nil
        XCTAssertFalse(RoleSuggestionRule.isPending(agent: a, suggestionAt: t))
        XCTAssertFalse(RoleSuggestionRule.isPending(agent: nil, suggestionAt: t))
    }

    func testResolvedOutcome() {
        XCTAssertTrue(RoleSuggestionRule.isDismissed(agent: Agent(id: "a", title: ""), suggestionAt: t), "no real role")
        XCTAssertTrue(RoleSuggestionRule.isDismissed(agent: Agent(id: "a", title: "New agent"), suggestionAt: t))
        XCTAssertFalse(RoleSuggestionRule.isDismissed(agent: Agent(id: "a", title: "Researcher"), suggestionAt: t))
        XCTAssertTrue(RoleSuggestionRule.isDismissed(agent: Agent(id: "a", title: "Researcher", roleSuggestionDismissedAt: t.addingTimeInterval(1)), suggestionAt: t))
        XCTAssertFalse(RoleSuggestionRule.isDismissed(agent: Agent(id: "a", title: "Researcher", roleSuggestionDismissedAt: t.addingTimeInterval(-1)), suggestionAt: t), "dismissed an older one")
    }
}

// The identity editor must send the avatar through the real API request path and keep edits on failure.
private final class ProfileRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var payload: Data?
    func record(_ request: URLRequest) {
        var data = request.httpBody
        if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var bytes = [UInt8](repeating: 0, count: 1024)
            var out = Data()
            while stream.hasBytesAvailable {
                let count = stream.read(&bytes, maxLength: bytes.count)
                if count <= 0 { break }
                out.append(contentsOf: bytes.prefix(count))
            }
            data = out
        }
        lock.lock(); defer { lock.unlock() }; payload = data
    }
    func body() -> Data? { lock.lock(); defer { lock.unlock() }; return payload }
}

private final class ProfileURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let handler = Self.handler, let url = request.url else { return }
        let (status, data) = handler(request)
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor
final class AgentIdentityPersistenceTests: XCTestCase {
    private func connectedWorld(status: Int, recorder: ProfileRequestRecorder) -> World {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ProfileURLProtocol.self]
        ProfileURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "PATCH")
            XCTAssertEqual(request.url?.path, "/v1/agents/a1")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-session")
            recorder.record(request)
            return (status, Data(#"{"message":"Save unavailable"}"#.utf8))
        }
        let world = World()
        world.agents = [Agent(id: "a1", name: "Original", title: "Research", status: "working", avatar: Avatar(shape: "blob", color: 4, eyes: "wink", accessory: "cap", thumbs: ["seed": "keep-me"], character: "bean"))]
        world.api = API(session: Session(server: URL(string: "https://profile.fixture.invalid")!, token: "fixture-session", userId: "u1", name: "Fixture", email: "fixture@example.invalid"), transport: URLSession(configuration: config))
        return world
    }

    func testSaveSendsAndRestoresAvatarWithoutDroppingLegacyFields() async throws {
        let recorder = ProfileRequestRecorder()
        let world = connectedWorld(status: 200, recorder: recorder)
        var draft = try XCTUnwrap(world.agent("a1"))
        draft.name = "  New name  "; draft.title = "New role"; draft.avatar?.character = "pink"
        try await world.saveAgentProfile(draft)
        let data = try XCTUnwrap(recorder.body())
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(body.keys), ["name", "title", "avatar"])
        let avatarData = try JSONSerialization.data(withJSONObject: try XCTUnwrap(body["avatar"]))
        let persistedAvatar = try JSONDecoder().decode(Avatar.self, from: avatarData)
        XCTAssertEqual(persistedAvatar, draft.avatar)
        XCTAssertEqual(world.agent("a1")?.avatar, persistedAvatar)
        XCTAssertEqual(world.agent("a1")?.name, "New name")
        XCTAssertEqual(world.agent("a1")?.title, "New role")
        XCTAssertEqual(world.agent("a1")?.status, "working")
    }

    func testFailedSaveLeavesOriginalIdentityAndDraftCanRetry() async throws {
        let recorder = ProfileRequestRecorder()
        let world = connectedWorld(status: 503, recorder: recorder)
        let original = try XCTUnwrap(world.agent("a1"))
        var draft = original; draft.name = "Edited"; draft.avatar?.character = "star"
        do { try await world.saveAgentProfile(draft); XCTFail("server failure must reach the editor") }
        catch { XCTAssertTrue(error.localizedDescription.contains("Save unavailable")) }
        XCTAssertEqual(world.agent("a1"), original)
        XCTAssertEqual(draft.avatar?.character, "star")
        ProfileURLProtocol.handler = { request in recorder.record(request); return (200, Data("{}".utf8)) }
        try await world.saveAgentProfile(draft)
        XCTAssertEqual(world.agent("a1")?.avatar?.character, "star")
    }

    func testBlankNameDoesNotSendOrMutateIdentity() async throws {
        let recorder = ProfileRequestRecorder()
        let world = connectedWorld(status: 200, recorder: recorder)
        let original = try XCTUnwrap(world.agent("a1"))
        var draft = original; draft.name = " \n "
        do { try await world.saveAgentProfile(draft); XCTFail("blank name must be refused") } catch {}
        XCTAssertNil(recorder.body())
        XCTAssertEqual(world.agent("a1"), original)
    }
}

// MARK: - Mentions

final class MentionsTests: XCTestCase {
    private let ada = Mention(kind: "agent", id: "ag_1", label: "@Ada")

    func testPickedMentionStaysWhileTokenIsInText() {
        XCTAssertEqual(Mentions.build(text: "hi @Ada please", picked: [ada]), [ada])
        XCTAssertEqual(Mentions.build(text: "hi please", picked: [ada]), [])
        XCTAssertEqual(Mentions.build(text: "typed @Ada by hand", picked: []), [])
    }

    func testTypedAllAndEveryoneAreBroadcasts() {
        XCTAssertEqual(Mentions.build(text: "Hello @all", picked: []), [Mention(kind: "agent", id: "all", label: "@all")])
        XCTAssertEqual(Mentions.build(text: "@Everyone go", picked: []), [Mention(kind: "agent", id: "everyone", label: "@everyone")])
        XCTAssertEqual(Mentions.build(text: "mail me@all.com", picked: []), [])
    }

    func testCodeSpansDoNotCount() {
        XCTAssertEqual(Mentions.build(text: "use `@all` here", picked: []), [])
        XCTAssertEqual(Mentions.build(text: "```\n@Ada\n```", picked: [ada]), [])
    }

    func testActiveQueryAndCompletion() {
        XCTAssertEqual(Mentions.activeQuery(in: "hi @A"), "A")
        XCTAssertEqual(Mentions.activeQuery(in: "@"), "")
        XCTAssertNil(Mentions.activeQuery(in: "a@b"))
        XCTAssertNil(Mentions.activeQuery(in: "hi @Ada "))
        XCTAssertEqual(Mentions.completing("hi @A", with: "Ada"), "hi @Ada ")
    }
}

// MARK: - PointerModel (phone mouse control geometry)

final class PointerModelTests: XCTestCase {
    /// A 1440x900 remote drawn 360x225 in the middle of a 360x400 surface (k = 4 pixels per point).
    private func model() -> PointerModel {
        var m = PointerModel()
        m.setLayout(fb: CGSize(width: 1440, height: 900), canvas: CGRect(x: 0, y: 87.5, width: 360, height: 225), container: CGSize(width: 360, height: 400))
        return m
    }

    func testCursorStartsCentredAndMapsBothWays() {
        let m = model()
        XCTAssertEqual(m.cursor, CGPoint(x: 720, y: 450))
        XCTAssertEqual(m.cursorScreen.x, 180, accuracy: 0.01)
        XCTAssertEqual(m.cursorScreen.y, 200, accuracy: 0.01)
        let p = m.fbPoint(fromScreen: CGPoint(x: 90, y: 87.5 + 112.5))
        XCTAssertEqual(p.x, 360, accuracy: 0.01)
        XCTAssertEqual(p.y, 450, accuracy: 0.01)
    }

    func testSlowDragIsOneToOneAndFastDragAccelerates() {
        var slow = model(); slow.moveCursor(by: CGSize(width: 10, height: 0), speed: 50)
        XCTAssertEqual(slow.cursor.x, 720 + 40, accuracy: 0.01)
        var fast = model(); fast.moveCursor(by: CGSize(width: 10, height: 0), speed: 1500)
        XCTAssertEqual(fast.cursor.x, 720 + 10 * 3 * 4, accuracy: 0.01)
        XCTAssertEqual(PointerModel.gain(speed: 0), 1)
        XCTAssertEqual(PointerModel.gain(speed: 99999), 3)
    }

    func testCursorIsClampedToTheScreen() {
        var m = model()
        m.moveCursor(by: CGSize(width: 5000, height: -5000), speed: 0)
        XCTAssertEqual(m.cursor, CGPoint(x: 1439, y: 0))
        m.place(atScreen: CGPoint(x: -50, y: 900))
        XCTAssertEqual(m.cursor, CGPoint(x: 0, y: 899))
    }

    func testZoomKeepsAnchorAndNeverUncoversTheSurface() {
        var m = model()
        let anchor = CGPoint(x: 300, y: 150)
        let before = m.fbPoint(fromScreen: anchor)
        m.zoom(by: 2, about: anchor)
        XCTAssertEqual(m.zoom, 2)
        let after = m.fbPoint(fromScreen: anchor)
        XCTAssertEqual(before.x, after.x, accuracy: 0.5)
        XCTAssertEqual(before.y, after.y, accuracy: 0.5)
        m.pan(by: CGSize(width: 9999, height: 9999))
        XCTAssertEqual(m.offset, .zero)
        m.pan(by: CGSize(width: -9999, height: -9999))
        XCTAssertEqual(m.offset, CGPoint(x: -360, y: -400))
        m.zoom(by: 0.1, about: anchor)
        XCTAssertEqual(m.zoom, 1)
        XCTAssertEqual(m.offset, .zero)
        m.zoom(by: 100, about: anchor)
        XCTAssertEqual(m.zoom, PointerModel.maxZoom)
    }

    func testZoomedViewFollowsTheCursorToTheEdge() {
        var m = model()
        m.zoom(by: 3, about: CGPoint(x: 180, y: 200))
        m.moveCursor(by: CGSize(width: 400, height: 0), speed: 0)
        m.followCursor(margin: 40)
        XCTAssertLessThanOrEqual(m.cursorScreen.x, 360 - 40 + 0.01)
        XCTAssertGreaterThanOrEqual(m.cursorScreen.x, 40 - 0.01)
    }
    // MARK: Focus and tap snapping

    func testFocusZoomsToTheElementAndCentresTheCursorOnIt() {
        var m = model()
        m.focus(on: CGRect(x: 1000, y: 600, width: 200, height: 100))
        XCTAssertEqual(m.zoom, 3)  // would be 5x for this small field: capped so the surroundings stay visible
        XCTAssertEqual(m.cursor, CGPoint(x: 1100, y: 650))
        XCTAssertEqual(m.cursorScreen.x, 180, accuracy: 0.01)
        XCTAssertEqual(m.cursorScreen.y, 200, accuracy: 0.01)
    }

    func testFocusOnAWholePageKeepsTheWholePicture() {
        var m = model()
        m.focus(on: CGRect(x: 0, y: 0, width: 1440, height: 900))
        XCTAssertEqual(m.zoom, 1)
        XCTAssertEqual(m.offset, .zero)
    }

    func testTapNearAControlSnapsIntoItsMiddleHalf() {
        let m = model()  // zoom 1: 24 points = 96 pixels
        let button = CGRect(x: 150, y: 90, width: 60, height: 40)
        XCTAssertEqual(m.snap(CGPoint(x: 100, y: 100), to: [button]), CGPoint(x: 165, y: 100))
        // Too far: raw. On the element already: raw.
        XCTAssertEqual(m.snap(CGPoint(x: 20, y: 100), to: [button]), CGPoint(x: 20, y: 100))
        XCTAssertEqual(m.snap(CGPoint(x: 152, y: 91), to: [button]), CGPoint(x: 152, y: 91))
        XCTAssertEqual(m.snap(CGPoint(x: 100, y: 100), to: []), CGPoint(x: 100, y: 100))
    }

    func testSnapPicksTheNearestThenTheSmallestAndShrinksWhenZoomedIn() {
        var m = model()
        let near = CGRect(x: 160, y: 100, width: 40, height: 40)
        let far = CGRect(x: 100, y: 200, width: 40, height: 40)
        XCTAssertEqual(m.snap(CGPoint(x: 120, y: 120), to: [far, near]).x, 170, accuracy: 0.01)
        let small = CGRect(x: 160, y: 100, width: 40, height: 40), big = CGRect(x: 160, y: 100, width: 80, height: 80)
        XCTAssertEqual(m.snap(CGPoint(x: 120, y: 120), to: [big, small]).x, 170, accuracy: 0.01)  // equal distance: the smaller wins
        m.zoom(by: 4, about: .zero)  // 24 points is now 24 pixels: the same touch is no longer "near"
        XCTAssertEqual(m.snap(CGPoint(x: 120, y: 120), to: [near]), CGPoint(x: 120, y: 120))
    }
}

final class TaskGroupsTests: XCTestCase {
    private func task(_ id: String, _ status: String, hoursAgo: Double, outcome: String? = nil, parent: String? = nil, kind: String = "task",
                      routine: String? = nil, childRun: String? = nil) -> Contract.AgentTask {
        let at = Date(timeIntervalSince1970: 1_800_000_000 - hoursAgo * 3600)
        let ended = status == "ended"
        return Contract.AgentTask(id: id, kind: kind, parentId: parent, status: status, outcome: ended ? (outcome ?? "done") : nil, childRunId: childRun, routineId: routine,
                                  startedAt: at, updatedAt: at, finishedAt: ended ? at : nil)
    }

    func testLiveThenFinishedByDay() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "UTC")!
        let tasks = [task("old", "ended", hoursAgo: 80), task("wait", "waiting", hoursAgo: 1), task("done", "ended", hoursAgo: 0.5),
                     task("run-old", "running", hoursAgo: 3), task("queued", "queued", hoursAgo: 2), task("yest", "ended", hoursAgo: 20, outcome: "failed")]
        let layout = TaskGroups.layout(tasks, limit: 10, now: now, calendar: cal)
        XCTAssertEqual(layout.active.map(\.id), ["wait", "queued", "run-old"])
        XCTAssertEqual(layout.days.map(\.title), ["Today", "Yesterday", layout.days[2].title])
        XCTAssertEqual(layout.days.flatMap(\.entries).map(\.id), ["done", "yest", "old"])
        XCTAssertEqual(layout.finishedTotal, 3)
    }

    func testTheCapAppliesToFinishedTasksOnly() {
        let tasks = [task("r", "running", hoursAgo: 1)] + (0..<5).map { task("c\($0)", "ended", hoursAgo: Double($0)) }
        let layout = TaskGroups.layout(tasks, limit: 2)
        XCTAssertEqual(layout.active.count, 1)
        XCTAssertEqual(layout.days.flatMap(\.entries).count, 2)
        XCTAssertEqual(layout.finishedTotal, 5)
    }

    func testChildrenHangUnderTheirParentAndAMissingParentIsTopLevel() {
        let sub = task("sub", "running", hoursAgo: 3, parent: "run-root", kind: "subagent", childRun: "run-child")
        let viaId = task("cmd", "ended", hoursAgo: 1, parent: "sub", kind: "command")
        let viaRun = task("conn", "ended", hoursAgo: 2, parent: "run-child", kind: "connector")
        let tree = TaskGroups.tree([viaId, sub, viaRun])
        XCTAssertEqual(tree.map(\.id), ["sub"])
        XCTAssertEqual(tree[0].children.map(\.id), ["conn", "cmd"])
        XCTAssertTrue(TaskGroups.layout([viaId, sub, viaRun], limit: 10).active.first?.isLive == true, "a live parent keeps its finished children on the Now list")
    }

    func testTasksThatPointAtEachOtherAreKept() {
        let tree = TaskGroups.tree([task("x", "running", hoursAgo: 1, parent: "y"), task("y", "running", hoursAgo: 1, parent: "x")])
        XCTAssertEqual(Set(tree.flatMap(\.tasks).map(\.id)), ["x", "y"])
    }

    func testRoutineRunsGatherUnderTheirRoutine() {
        let tasks = [task("r1", "ended", hoursAgo: 5, kind: "routine", routine: "digest"), task("plain", "running", hoursAgo: 1), task("r2", "ended", hoursAgo: 30, outcome: "failed", kind: "routine", routine: "digest")]
        let entries = TaskGroups.entries(tasks)
        XCTAssertEqual(entries.count, 2)
        guard case .routine(let id, let runs) = entries[0] else { return XCTFail("the routine group leads, at its first run's place") }
        XCTAssertEqual(id, "digest")
        XCTAssertEqual(runs.map(\.id), ["r1", "r2"])
    }

    func testWordsForEveryStateAndWhereATapGoes() {
        func words(_ status: String, waitingFor: String? = nil, outcome: String? = nil, detail: String? = nil, progress: String? = nil, result: String? = nil) -> Contract.AgentTask {
            Contract.AgentTask(id: "t", conversationId: "conv", status: status, waitingFor: waitingFor, outcome: outcome, outcomeDetail: detail, progress: progress, resultLine: result)
        }
        XCTAssertEqual(TaskWords.phase(words("queued")).label, "Queued")
        XCTAssertEqual(TaskWords.phase(words("waiting", waitingFor: "approval")).label, "Waiting for approval")
        XCTAssertEqual(TaskWords.phase(words("ended", outcome: "failed")).label, "Didn't finish")
        XCTAssertEqual(TaskWords.phase(words("ended", outcome: "cancelled")).label, "Stopped")
        XCTAssertEqual(TaskWords.phase(words("ended", outcome: "unknown_effect")).label, "Outcome unknown, check before retrying")
        XCTAssertEqual(TaskWords.subtitle(words("ended", outcome: "failed", detail: "timed_out", result: "Exited with code 1")), "Timed out \u{00B7} Exited with code 1")
        XCTAssertEqual(TaskWords.subtitle(words("waiting", waitingFor: "owner_input", progress: "Which baseline?")), "Waiting for you \u{00B7} Which baseline?")
        XCTAssertEqual(TaskWords.needsYou(words("waiting", waitingFor: "owner_input")), "conv")
        XCTAssertEqual(TaskWords.needsYou(words("ended", outcome: "unknown_effect", detail: "effect_review")), "conv")
        XCTAssertEqual(TaskWords.needsYou(words("ended", outcome: "needs_input")), "conv")
        XCTAssertNil(TaskWords.needsYou(words("waiting", waitingFor: "event")))
        XCTAssertNil(TaskWords.needsYou(words("ended", outcome: "failed")))
    }

    func testAFoldedParentShowsADescendantThatNeedsThePerson() {
        let top = Contract.AgentTask(id: "top", kind: "subagent", status: "running", childRunId: "run-top")
        let mid = Contract.AgentTask(id: "mid", kind: "subagent", parentId: "run-top", status: "running", childRunId: "run-mid")
        let leaf = Contract.AgentTask(id: "leaf", kind: "task", parentId: "run-mid", status: "waiting", waitingFor: "approval")
        let question = Contract.AgentTask(id: "q", kind: "task", parentId: "run-top", status: "waiting", waitingFor: "owner_input")
        let tree = TaskGroups.tree([top, mid, leaf])
        XCTAssertEqual(tree.count, 1)
        let parent = tree[0]
        XCTAssertEqual(parent.descendantsNeedingYou?.label, "Waiting for approval")
        XCTAssertEqual(parent.descendantsNeedingYou?.line, "1 needs you")
        XCTAssertEqual(parent.children[0].descendantsNeedingYou?.label, "Waiting for approval", "the middle level shows it too")
        XCTAssertTrue(TaskTreeRow.startsExpanded(parent))
        XCTAssertTrue(TaskTreeRow.startsExpanded(parent.children[0]))
        XCTAssertNil(parent.children[0].children[0].descendantsNeedingYou, "a leaf has nothing below it")
        let both = TaskGroups.tree([top, mid, leaf, question])[0]
        XCTAssertEqual(both.descendantsNeedingYou?.line, "2 need you")
        XCTAssertEqual(both.descendantsNeedingYou?.label, "Waiting for approval", "approval outranks a question")
        XCTAssertNil(TaskGroups.tree([top, mid])[0].descendantsNeedingYou)
        XCTAssertFalse(TaskTreeRow.startsExpanded(TaskGroups.tree([top, mid])[0]))
    }

    func testDecodesTheTaskTreeShape() throws {
        let json = """
        {"id":"t1","kind":"routine","agentId":"a","parentId":"p","rootRunId":"r","depth":1,
         "origin":{"type":"routine","routineId":"rt","occurrenceAt":"2026-10-29T08:00:00.000Z"},"mode":"scheduled","replyTo":{"type":"delivery","channel":"chat"},
         "status":"ended","outcome":"failed","outcomeDetail":"timed_out","title":"Digest","resultLine":"Timed out","routineId":"rt",
         "startedAt":"2026-10-29T08:00:00.000Z","updatedAt":"2026-10-29T08:05:00.000Z"}
        """
        let task = try isoDecoder.decode(Contract.AgentTask.self, from: Data(json.utf8))
        XCTAssertEqual(task.status, "ended")
        XCTAssertEqual(task.outcomeDetail, "timed_out")
        XCTAssertEqual(task.origin?.startedByLine(routineName: "Daily digest"), "Started by a routine \u{00B7} Daily digest")
        XCTAssertEqual(task.depth, 1)
    }
}

// MARK: - Reconnecting grace

final class ReconnectGraceTests: XCTestCase {
    func testReconnecting() {
        let now = Date()
        XCTAssertFalse(World.showsReconnecting(live: true, now: now, graceUntil: .distantPast, busy: true))
        XCTAssertFalse(World.showsReconnecting(live: false, now: now, graceUntil: now.addingTimeInterval(4), busy: true), "within the resume grace")
        XCTAssertFalse(World.showsReconnecting(live: false, now: now, graceUntil: .distantPast, busy: false), "nothing pending or running")
        XCTAssertTrue(World.showsReconnecting(live: false, now: now.addingTimeInterval(5), graceUntil: now.addingTimeInterval(4), busy: true))
    }
}

// MARK: - LocalStore (the chat's on-device database)

final class LocalStoreTests: XCTestCase {
    func testItemsPagingAndCursorSurviveReopen() throws {
        let url = FileManager.default.temporaryDirectory.appending(path: "store-\(UUID().uuidString).sqlite")
        defer { try? FileManager.default.removeItem(at: url) }
        let items = (1...5).map { Item(id: "i\($0)", conversationId: "c", at: Date(timeIntervalSince1970: Double($0)), type: "user_message", text: "m\($0)") }

        let store = try LocalStore(url: url)
        XCTAssertFalse(store.upsertLive("c", [items[4]]), "a chat without its newest page stores nothing live")
        store.replaceNewest("c", items: Array(items[2...]), olderCursor: "cur")
        XCTAssertEqual(store.newest("c", limit: 2).map(\.id), ["i4", "i5"])
        XCTAssertTrue(store.older("c", than: items[2], limit: 5).isEmpty)
        XCTAssertEqual(store.chatState("c"), .init(olderCursor: "cur", reachedStart: false))

        store.appendOlder("c", items: Array(items[..<2]), olderCursor: nil)
        XCTAssertEqual(store.older("c", than: items[2], limit: 5).map(\.id), ["i1", "i2"])
        XCTAssertEqual(store.chatState("c"), .init(olderCursor: nil, reachedStart: true))

        var edited = items[4]; edited.text = "edited"
        XCTAssertTrue(store.upsertLive("c", [edited]))
        store.setCursor(42)

        let reopened = try LocalStore(url: url)
        XCTAssertEqual(reopened.cursor(), 42)
        XCTAssertEqual(reopened.newest("c", limit: 10).map(\.id), ["i1", "i2", "i3", "i4", "i5"])
        XCTAssertEqual(reopened.newest("c", limit: 1).first?.text, "edited")
        reopened.wipeHistory()
        XCTAssertNil(reopened.cursor())
        XCTAssertTrue(reopened.newest("c", limit: 10).isEmpty)
    }

    func testEachAccountAndServerGetsItsOwnFile() {
        let a = URL(string: "https://one.example")!, b = URL(string: "https://two.example")!
        XCTAssertNotEqual(LocalStore.fileName(server: a, userId: "u1"), LocalStore.fileName(server: a, userId: "u2"))
        XCTAssertNotEqual(LocalStore.fileName(server: a, userId: "u1"), LocalStore.fileName(server: b, userId: "u1"))
        XCTAssertEqual(LocalStore.fileName(server: a, userId: "u1"), LocalStore.fileName(server: a, userId: "u1"))
    }
}

// MARK: - Interactive keyboard decisions

@MainActor
final class ChatKeyboardTests: XCTestCase {
    func testFingerHoldsTheKeyboardAtItsUpperBound() {
        // 844 high, keyboard 300: its top is at 544. A finger-held bound at 644 pushes it 100 down.
        XCTAssertEqual(ChatKeyboardController.interactiveOffset(upperBound: 644, viewHeight: 844, keyboardHeight: 300), 100)
        XCTAssertEqual(ChatKeyboardController.interactiveOffset(upperBound: 500, viewHeight: 844, keyboardHeight: 300), 0)
        XCTAssertEqual(ChatKeyboardController.interactiveOffset(upperBound: nil, viewHeight: 844, keyboardHeight: 300), 0)
    }

    func testReleaseDismissesByPositionOrFlickOnlyInsideTheKeyboardZone() {
        func can(_ bound: CGFloat?, _ velocity: CGFloat?, _ y: CGFloat) -> Bool {
            ChatKeyboardController.canDismiss(upperBound: bound, viewHeight: 844, accessoryHeight: 60, velocity: velocity, fingerY: y, keyboardHeight: 300)
        }
        XCTAssertTrue(can(790, 0, 740), "dragged all the way down")
        XCTAssertTrue(can(600, 150, 700), "a flick")
        XCTAssertFalse(can(600, 50, 700), "slow and not at the bottom: spring back")
        XCTAssertFalse(can(nil, 150, 400), "released above the keyboard zone")
    }

    func testInsetChangeKeepsContentGluedUnlessAFingerHoldsIt() {
        func offset(current: CGFloat, tracking: Bool, scrollToNewest: Bool = false) -> CGFloat {
            ChatListController.offset(current: current, oldTop: 300, newTop: 100, contentHeight: 3000, boundsHeight: 800,
                                      insetBottom: 90, tracking: tracking, scrollToNewest: scrollToNewest)
        }
        XCTAssertEqual(offset(current: 500, tracking: false), 700, "glued to the composer")
        XCTAssertEqual(offset(current: 500, tracking: true), 500, "under the finger: unchanged")
        XCTAssertEqual(offset(current: -300, tracking: true), -100, "clamped to the new newest edge")
        XCTAssertEqual(offset(current: 500, tracking: true, scrollToNewest: true), -100)
        XCTAssertEqual(offset(current: 2300, tracking: false), 2290, "clamped to the oldest end")
    }
}

// MARK: - stepLine

final class StepLineTests: XCTestCase {
    private func step(verb: String = "Executed", target: String, input: String? = nil, output: String? = nil, status: String = "completed") -> Step {
        Step(id: "s", kind: "mcp", verb: verb, target: target, input: StepInput(summary: input), output: StepOutput(summary: output), status: status)
    }

    func testNavigateShowsTitleAndHost() {
        let s = step(target: "browser.navigate", input: #"{"url":"https://www.samsung.com/sg/buy/"}"#,
                     output: "Navigated tab t1 to Buy Galaxy S26 (https://www.samsung.com/sg/buy/)\n\nSnapshot of tab t1: x\n- e138 [link] Samsung")
        let line = stepLine(s)
        XCTAssertEqual(line?.text, "Opened Buy Galaxy S26 in the browser")
        XCTAssertEqual(line?.domain, "samsung.com")
    }

    func testBingReadIsASearch() {
        let s = step(verb: "Read", target: "www.bing.com", input: #"{"url":"https://www.bing.com/search?q=Galaxy+S26+price","maxChars":6500}"#, output: "Title: Galaxy S26 price - Search\nURL: x")
        XCTAssertEqual(stepLine(s)?.text, "Searched for \u{201C}Galaxy S26 price\u{201D}")
    }

    func testClickUsesTheRefLabelNeverTheRef() {
        let s = step(target: "browser.click", input: #"{"ref":"e144"}"#, output: "Clicked e144 on tab t1\n- e144 [button] Expand")
        XCTAssertEqual(stepLine(s)?.text, "Clicked Expand")
        XCTAssertEqual(stepLine(step(target: "computer.click", input: #"{"x":237,"y":669}"#))?.text, "Clicked on the page")
        // The backend now names the control in the result itself.
        XCTAssertEqual(stepLine(step(target: "browser.click", input: #"{"ref":"e681"}"#, output: #"Clicked "512 GB" (e681) on tab t1 (https://x)"#))?.text, "Clicked 512 GB")
        XCTAssertEqual(stepLine(step(target: "computer.click", input: #"{"x":1,"y":2}"#, output: #"Clicked "Buy now" at (1, 2)"#))?.text, "Clicked Buy now")
    }

    func testOnlyWhatTheBackendMarksInternalIsHidden() {
        for tool in ["task_update", "send_message", "computer.screenshot"] {
            var plumbing = step(target: tool)
            plumbing.internal = true
            XCTAssertNil(stepLine(plumbing), tool)
            // The same tool without the flag shows: the app keeps no list of names.
            XCTAssertNotNil(stepLine(step(target: tool)), tool)
        }
    }

    func testRefusedPurchaseWaitsForApproval() {
        let s = step(target: "browser.click", input: #"{"ref":"e775"}"#, output: "Not clicked: \"Buy now\" places the order or pays.", status: "failed")
        XCTAssertEqual(stepLine(s)?.text, "Waiting for your approval to place the order")
        XCTAssertEqual(stepLine(step(target: "github_create_issue"))?.text, "Github create issue")
    }

    func testStepsSayWhenTheyRanOnTheMac() {
        XCTAssertEqual(stepLine(step(target: "shell.run", input: #"{"command":"ls"}"#))?.text, "Ran ls")
        XCTAssertEqual(stepLine(step(target: "shell.run", input: #"{"command":"ls","on":"mac"}"#))?.text, "Ran ls on your Mac")
        XCTAssertEqual(stepLine(step(target: "files.edit", input: #"{"path":"~/Juno/notes.md","on":"mac"}"#))?.text, "Edited notes.md on your Mac")
        XCTAssertEqual(stepLine(step(target: "computer_copy", input: #"{"from":"sandbox","to":"mac","path":"/workspace/report.pdf"}"#))?.text, "Copied report.pdf from the sandbox to your Mac")
        XCTAssertEqual(stepLine(step(target: "computer_copy", input: #"{"from":"mac","to":"sandbox","path":"~/Juno/report.pdf"}"#))?.text, "Copied report.pdf from your Mac to the sandbox")
    }
}

// Agent prose: CJK bold, `•` lines, chat-style line breaks (AgentMarkdown.normalizingProse) and the feed card's summary fallback.
final class AgentProseTests: XCTestCase {
    private let sample = "截至 2026 年 10 月 15 日，本周值得关注的两条 OpenAI 动态：\n• **欧洲扩张：**OpenAI 宣布在爱尔兰新增 200 个岗位。\n• **监管与安全争议：**10 月 14 日，美国 8 个州。"

    func testBoldNextToCJKPunctuationClosesAndBulletsBecomeListItems() {
        let out = AgentMarkdown.normalizingProse(sample).split(separator: "\n").map(String.init)
        XCTAssertEqual(out.count, 3)
        XCTAssertEqual(out[1], "- **欧洲扩张：**\u{200A}OpenAI 宣布在爱尔兰新增 200 个岗位。  ")
        XCTAssertTrue(out[2].hasPrefix("- **监管与安全争议：**\u{200A}10 月"))
        XCTAssertTrue(out[0].hasSuffix("  "), "a single newline is a line break")
    }

    func testCodeSpansAndFencesStayLiteral() {
        XCTAssertEqual(AgentMarkdown.normalizingProse("Run `**a：**b` now"), "Run `**a：**b` now")
        let fenced = "```\n• **a：**b\n```"
        XCTAssertEqual(AgentMarkdown.normalizingProse(fenced), fenced)
    }

    func testCardSummaryFallsBackToThePlainBody() {
        let post = FeedPost(id: "p", body: "## Title\n• **Bold** and [link](https://x.y)\n" + String(repeating: "字", count: 300))
        let text = post.cardSummary ?? ""
        XCTAssertTrue(text.hasPrefix("Title Bold and link"))
        XCTAssertEqual(text.count, 240)
        XCTAssertEqual(FeedPost(id: "q", summary: "S", body: "B").cardSummary, "S")
    }
}

// Which chats the main list shows: the owner's own chats. Platform groups and strangers' DMs live under Groups
// (same rule as the web sidebar, chatEntries.ts isChannelChat).
final class ChannelChatTests: XCTestCase {
    private func conversation(kind: String, channel: ConversationChannel?, title: String? = nil) -> Conversation {
        Conversation(id: "c", kind: kind, title: title, agentIds: ["a"], memberIds: [], unreadCount: 0, needsYou: 0,
                     pinned: false, muted: false, lastMessagePreview: nil, lastItemAt: nil, channel: channel)
    }

    func testOwnerChatsAreNotChannelChats() {
        XCTAssertFalse(conversation(kind: "direct", channel: nil).isChannelChat)
        XCTAssertFalse(conversation(kind: "room", channel: nil).isChannelChat)
        XCTAssertFalse(conversation(kind: "direct", channel: ConversationChannel(kind: "slack", channelId: "D1")).isChannelChat,
                       "the owner's platform DM is the in-app chat")
    }

    func testGroupsAndStrangersDMsAreChannelChats() {
        XCTAssertTrue(conversation(kind: "room", channel: ConversationChannel(kind: "slack", channelId: "C1"), title: "#general · Slack").isChannelChat)
        XCTAssertTrue(conversation(kind: "direct", channel: ConversationChannel(kind: "slack", channelId: "D2"), title: "Dana · Slack").isChannelChat)
        XCTAssertTrue(conversation(kind: "task", channel: ConversationChannel(kind: "telegram", channelId: "T1")).isChannelChat)
    }
}

/// A real hosted row moving across the window's safe area must keep its drawing and geometry together.
@MainActor
final class ChatCellDrawingTests: XCTestCase {
    func testBubbleDrawingStaysInsideRowAcrossSafeArea() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        let controller = ChatListController(store: ChatStore())
        controller.additionalSafeAreaInsets.bottom = 100
        window.rootViewController = controller
        window.isHidden = false
        defer { window.isHidden = true }
        controller.view.layoutIfNeeded()

        let world = World()
        controller.context = ChatContext(world: world, conversationId: "drawing-regression", isGroup: false, accent: nil, openRoute: { _ in })
        let entries = (0..<20).map { index in
            ChatEntry(id: "drawing-\(index)", item: Item(id: "drawing-\(index)", type: "agent_message", markdown: "A multiline reply that must remain in its own bubble.\nThe second line stays visible as the row scrolls."))
        }
        controller.update(entries)
        try await Task.sleep(for: .seconds(1))
        func findList(_ view: UIView) -> UICollectionView? {
            if let list = view as? UICollectionView { return list }
            return view.subviews.compactMap(findList).first
        }
        let list = try XCTUnwrap(findList(controller.view))
        for y: CGFloat in [0, 62, 200, 0] {
            list.setContentOffset(CGPoint(x: 0, y: y), animated: false)
            controller.view.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(200))
            if y == 62 {
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                    window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                }
                let attachment = XCTAttachment(image: image)
                attachment.name = "chat-cells-crossing-safe-area"
                attachment.lifetime = .keepAlways
                add(attachment)
            }
            let cells = list.visibleCells.compactMap { $0 as? ChatCell }
            XCTAssertFalse(cells.isEmpty)
            for cell in cells {
                let logical = cell.bubbleRect
                XCTAssertGreaterThan(logical.height, 0)
                // Inspect public CALayer geometry rather than private SwiftUI class names or a screenshot's text.
                func backgrounds(_ layer: CALayer) -> [CALayer] {
                    (layer.sublayers ?? []).flatMap { child in
                        let matches = abs(child.bounds.width - logical.width) < 1 && abs(child.bounds.height - logical.height) < 1
                        return (matches ? [child] : []) + backgrounds(child)
                    }
                }
                let backing = try XCTUnwrap(backgrounds(cell.contentView.layer).first, "bubble backing must be present")
                let drawn = backing.convert(backing.bounds, to: cell.contentView.layer)
                XCTAssertEqual(drawn.minY, logical.minY, accuracy: 1, "drawing moved away from bubble geometry at scroll y=\(y)")
            }
        }
    }
}

private final class AgentCreationRequests: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [URLRequest] = []
    func record(_ request: URLRequest) { lock.lock(); defer { lock.unlock() }; requests.append(request) }
    func conversationCreates() -> Int {
        lock.lock(); defer { lock.unlock() }
        return requests.filter { $0.httpMethod == "POST" && $0.url?.path == "/v1/conversations" }.count
    }
}

@MainActor
final class AgentCreationChatTests: XCTestCase {
    private func connectedWorld(requests: AgentCreationRequests, listed: String, listStatus: Int = 200) -> World {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProfileURLProtocol.self]
        ProfileURLProtocol.handler = { request in
            requests.record(request)
            if request.httpMethod == "POST", request.url?.path == "/v1/agents" {
                return (201, Data(#"{"id":"a-new","name":"New agent"}"#.utf8))
            }
            if request.httpMethod == "GET", request.url?.path == "/v1/conversations" {
                return (listStatus, Data(listed.utf8))
            }
            if request.httpMethod == "POST", request.url?.path == "/v1/conversations" {
                return (201, Data(#"{"id":"fallback-chat","kind":"direct","agentIds":["a-new"],"memberIds":["owner"]}"#.utf8))
            }
            return (200, Data(#"{"items":[]}"#.utf8))
        }
        let world = World()
        world.selfId = "owner"
        world.api = API(session: Session(server: URL(string: "https://create.fixture.invalid")!, token: "fixture", userId: "owner", name: "Fixture", email: "fixture@example.invalid"), transport: URLSession(configuration: configuration))
        return world
    }

    func testUsesOnboardingChatEvenBeforeItsLiveEventArrives() async throws {
        let requests = AgentCreationRequests()
        let world = connectedWorld(requests: requests, listed: #"{"items":[{"id":"platform-chat","kind":"direct","title":"Stranger · Slack","agentIds":["a-new"],"memberIds":["owner"],"channel":{"kind":"slack","channelId":"stranger"}},{"id":"someone-elses-chat","kind":"direct","agentIds":["a-new"],"memberIds":["someone-else"]},{"id":"welcome-chat","kind":"direct","agentIds":["a-new"],"memberIds":["owner"]}]}"#)
        defer { ProfileURLProtocol.handler = nil }
        let chatId = try await world.createAgent(name: "New agent", role: "", openChat: false)
        XCTAssertEqual(chatId, "welcome-chat")
        XCTAssertEqual(requests.conversationCreates(), 0, "the backend already created the agent's welcome chat")
        XCTAssertEqual(world.conversations.map(\.id), ["welcome-chat"])
        XCTAssertEqual(world.agents.map(\.id), ["a-new"])
        XCTAssertNil(world.currentConversationId, "embedded creation leaves navigation to its caller")
    }

    func testCreatesOneChatWhenOnboardingDidNotCreateOne() async throws {
        let requests = AgentCreationRequests()
        let world = connectedWorld(requests: requests, listed: #"{"items":[]}"#)
        defer { ProfileURLProtocol.handler = nil }
        let chatId = try await world.createAgent(name: "New agent", role: "", openChat: false)
        XCTAssertEqual(chatId, "fallback-chat")
        XCTAssertEqual(requests.conversationCreates(), 1)
        XCTAssertEqual(world.conversations.map(\.id), ["fallback-chat"])
    }

    func testLookupFailureDoesNotCreateAnotherChat() async throws {
        let requests = AgentCreationRequests()
        let world = connectedWorld(requests: requests, listed: #"{"message":"Temporarily unavailable"}"#, listStatus: 503)
        defer { ProfileURLProtocol.handler = nil }
        do {
            _ = try await world.createAgent(name: "New agent", role: "", openChat: false)
            XCTFail("a failed lookup must not be treated as an empty chat list")
        } catch {
            XCTAssertEqual(requests.conversationCreates(), 0)
            XCTAssertTrue(world.conversations.isEmpty)
        }
    }
}

// MARK: - AG-UI native migration

private final class AguiRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var seen: [URLRequest] = []
    private var bodies: [Data] = []
    private var attempt = 0

    func record(_ request: URLRequest) -> Int {
        lock.lock(); defer { lock.unlock() }
        seen.append(request)
        var body = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                body.append(contentsOf: buffer.prefix(count))
            }
        }
        bodies.append(body)
        return seen.count
    }

    func count() -> Int { lock.lock(); defer { lock.unlock() }; return seen.count }
    func requests() -> [URLRequest] { lock.lock(); defer { lock.unlock() }; return seen }
    func body(_ i: Int) -> Data { lock.lock(); defer { lock.unlock() }; return bodies[i] }
}

private final class AguiURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let handler = Self.handler, let url = request.url else { return }
        let (status, data) = handler(request)
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor
final class AguiNativeTests: XCTestCase {
    private func data(_ object: [String: Any]) -> Data {
        try! JSONSerialization.data(withJSONObject: object)
    }

    private func json(_ data: Data) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func connected(_ recorder: AguiRequestRecorder, reply: @escaping @Sendable (URLRequest, Int) -> (Int, Data)) -> World {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [AguiURLProtocol.self]
        AguiURLProtocol.handler = { request in reply(request, recorder.record(request)) }
        let world = World()
        world.selfId = "owner"
        world.api = API(session: Session(server: URL(string: "https://agui.fixture.invalid")!, token: "fixture",
                                        userId: "owner", name: "Fixture", email: "fixture@example.invalid"),
                        transport: URLSession(configuration: config))
        return world
    }

    private func wait(_ condition: @escaping @MainActor () -> Bool) async -> Bool {
        for _ in 0..<100 {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(20))
        }
        return condition()
    }

    func testMessagesSnapshotMergesWithoutDroppingPagingOrOutbox() throws {
        let world = World()
        let older = Item(id: "old", conversationId: "c1", at: Date(timeIntervalSince1970: 1), type: "agent_message", agentId: "a1", markdown: "old")
        let outbox = Item(id: "local", conversationId: "c1", at: Date(timeIntervalSince1970: 2), type: "user_message", authorId: "owner", text: "unsent")
        world.items["c1"] = [older, outbox]
        world.history["c1"] = ChatHistory(olderCursor: "page-2", reachedStart: false)
        world.outbox["local"] = .some(nil)
        let embedded: [String: Any] = ["id": "committed", "conversationId": "c1", "at": "2026-10-29T00:00:00Z",
                                       "type": "agent_message", "agentId": "a1", "markdown": "authoritative", "citations": []]
        let snapshot: [String: Any] = ["type": "MESSAGES_SNAPSHOT", "metadata": ["juno": ["conversationId": "c1"]],
            "messages": [["id": "committed", "role": "assistant", "content": "authoritative",
                          "metadata": ["juno": ["conversationId": "c1", "agentId": "a1", "item": embedded]]]]]
        _ = world.applyAgui(data(snapshot))
        _ = world.applyAgui(data(snapshot))
        XCTAssertEqual(world.items["c1"]?.filter { $0.id == "committed" }.count, 1)
        XCTAssertNotNil(world.items["c1"]?.first { $0.id == "old" })
        XCTAssertNotNil(world.items["c1"]?.first { $0.id == "local" })
        XCTAssertEqual(world.outbox["local"], .some(nil))
        XCTAssertEqual(world.history["c1"]?.olderCursor, "page-2")
    }

    func testComposerUsesStandardRunAndRetryKeepsStableId() async throws {
        let recorder = AguiRequestRecorder()
        let world = connected(recorder) { _, attempt in
            attempt == 1 ? (503, Data(#"{"error":{"code":"OFFLINE","message":"offline"}}"#.utf8))
                         : (202, Data(#"{"runId":"r1"}"#.utf8))
        }
        defer { AguiURLProtocol.handler = nil }
        let file = Attachment(id: "att-1", name: "photo.png", kind: "image", mimeType: "image/png")
        let mention = Mention(kind: "agent", id: "a1", label: "@Ada")
        world.send("hello", in: "c1", files: [file], mentions: [mention])
        let local = try XCTUnwrap(world.items["c1"]?.last)
        let failed = await wait { if case .some(.some) = world.outbox[local.id] { true } else { false } }
        XCTAssertTrue(failed)
        XCTAssertNotNil(recorder.requests().first?.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(recorder.requests().first?.url?.path, "/v1/conversations/c1/runs")

        world.retry(local.id, in: "c1")
        let retried = await wait { world.outbox[local.id] == nil }
        XCTAssertTrue(retried)
        XCTAssertEqual(recorder.count(), 2)
        for i in 0..<2 {
            let body = try json(recorder.body(i))
            XCTAssertEqual(body["threadId"] as? String, "c1")
            let messages = try XCTUnwrap(body["messages"] as? [[String: Any]])
            XCTAssertEqual(messages.first?["id"] as? String, local.id)
            let content = try XCTUnwrap(messages.first?["content"] as? [[String: Any]])
            XCTAssertEqual(content.compactMap { $0["type"] as? String }, ["text"], "no URL means no invalid standard attachment part")
            let forwarded = try XCTUnwrap(body["forwardedProps"] as? [String: Any])
            let composer = try XCTUnwrap((forwarded["juno"] as? [String: Any])?["composer"] as? [String: Any])
            XCTAssertEqual(composer["text"] as? String, "hello")
            XCTAssertEqual((composer["attachments"] as? [[String: Any]])?.first?["id"] as? String, "att-1")
            XCTAssertEqual((composer["mentions"] as? [[String: Any]])?.first?["id"] as? String, "a1")
        }
    }

    func testApprovalUsesRunAgentInputResume() async throws {
        let recorder = AguiRequestRecorder()
        let world = connected(recorder) { _, _ in (202, Data(#"{"runId":"r1"}"#.utf8)) }
        defer { AguiURLProtocol.handler = nil }
        world.requests = [AgentRequest(id: "req1", kind: "approval", status: "pending", agentId: "a1",
                                       conversationId: "c1", runId: "r1")]
        world.resolve("req1", decision: "approved", scope: "once")
        let sent = await wait { recorder.count() == 1 }
        XCTAssertTrue(sent)
        XCTAssertEqual(recorder.requests().first?.url?.path, "/v1/conversations/c1/runs")
        let body = try json(recorder.body(0))
        XCTAssertEqual(body["threadId"] as? String, "c1")
        let entry = try XCTUnwrap((body["resume"] as? [[String: Any]])?.first)
        XCTAssertEqual(entry["interruptId"] as? String, "req1")
        XCTAssertEqual(entry["status"] as? String, "resolved")
        XCTAssertEqual((entry["payload"] as? [String: Any])?["action"] as? String, "approve")
    }

    /// Two pending cards of one interrupted segment: a standard resume with one entry would leave the other
    /// interrupt unanswered, so the product decision route carries this single answer instead.
    func testApprovalWithAnotherPendingCardUsesTheProductResolveRoute() async throws {
        let recorder = AguiRequestRecorder()
        let world = connected(recorder) { _, _ in (200, Data("{}".utf8)) }
        defer { AguiURLProtocol.handler = nil }
        world.requests = [
            AgentRequest(id: "req1", kind: "approval", status: "pending", agentId: "a1", conversationId: "c1", runId: "r1"),
            AgentRequest(id: "req2", kind: "approval", status: "pending", agentId: "a1", conversationId: "c1", runId: "r1"),
        ]
        world.resolve("req1", decision: "approved", scope: "once")
        let sent = await wait { recorder.count() == 1 }
        XCTAssertTrue(sent)
        XCTAssertEqual(recorder.requests().first?.url?.path, "/v1/requests/req1/resolve")
        let body = try json(recorder.body(0))
        XCTAssertEqual(body["action"] as? String, "approve")
        XCTAssertNil(body["resume"])
        XCTAssertEqual(world.requests.first { $0.id == "req2" }?.status, "pending")
    }
}
