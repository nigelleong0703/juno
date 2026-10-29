import XCTest
@testable import Juno

/// The typing report is throttled to one `true` per second with a trailing one after a burst, and ends with `false`.
@MainActor
final class TypingReporterTests: XCTestCase {
    private var clock = Date(timeIntervalSince1970: 1_000)
    private var posts: [String] = []
    private var pending: [(delay: TimeInterval, work: @MainActor () -> Void)] = []

    private func make() -> TypingReporter {
        let reporter = TypingReporter(
            now: { [unowned self] in clock },
            schedule: { [unowned self] delay, work in
                let index = pending.count
                pending.append((delay, work))
                return { [unowned self] in if index < pending.count { pending[index].work = {} } }
            },
            post: { [unowned self] id, active in posts.append("\(id):\(active)") })
        reporter.setConversation("c1")
        return reporter
    }

    func testABurstPostsOnceThenOneTrailingPost() {
        let reporter = make()
        reporter.report()
        clock += 0.2; reporter.report()
        clock += 0.2; reporter.report()
        XCTAssertEqual(posts, ["c1:true"])
        XCTAssertEqual(pending.count, 1, "one trailing post is scheduled, not one per keystroke")
        XCTAssertEqual(pending[0].delay, 0.8, accuracy: 0.001)
        clock += 0.6
        pending[0].work()
        XCTAssertEqual(posts, ["c1:true", "c1:true"])
    }

    func testStopPostsFalseOnlyWhenActiveAndCancelsTheTrailingPost() {
        let reporter = make()
        reporter.stop()
        XCTAssertEqual(posts, [], "nothing was typed, nothing to end")
        reporter.report()
        clock += 0.1; reporter.report()
        reporter.stop()
        XCTAssertEqual(posts, ["c1:true", "c1:false"])
        pending.forEach { $0.work() }
        XCTAssertEqual(posts, ["c1:true", "c1:false"], "the cancelled trailing post never fires")
    }

    func testSwitchingChatEndsActivityOnThePreviousOneOnly() {
        let reporter = make()
        reporter.report()
        reporter.setConversation("c2")
        XCTAssertEqual(posts, ["c1:true", "c1:false"])
        clock += 2
        reporter.report()
        XCTAssertEqual(posts.last, "c2:true")
    }

    func testNoConversationNeverReports() {
        let reporter = make()
        reporter.setConversation(nil)
        reporter.report()
        reporter.stop()
        XCTAssertEqual(posts, [])
    }
}
