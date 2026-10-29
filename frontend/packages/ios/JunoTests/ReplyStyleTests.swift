import XCTest
@testable import Juno

// The learned reply style (ALIGNMENT_SYNTHESIS.md) as the Memory tab shows it: rules without the title or the claim marker.

final class ReplyStyleTests: XCTestCase {
    private let file = """
    # How this user likes to be answered
    Last updated from 2026-10-24 conversations.

    - Keep it short. [claim:clm_a1]
    - Answer in Dutch when they write Dutch.
    ## Juno（agt-1）
    - Skip the pleasantries with Juno. [claim:clm_b2]
    ## Sol（agt-2）
    - Only for Sol. [claim:clm_c3]
    """

    func testDropsTheTitleParsesTheDateAndStripsTheMarkerKeepingItsId() throws {
        let style = LearnedReplyStyle.parse(LearnedReplyStyle.replyStyle(file, agentId: "agt-1"))
        XCTAssertEqual(style.rules, [
            ReplyRule(text: "Keep it short.", claimId: "clm_a1"),
            ReplyRule(text: "Answer in Dutch when they write Dutch.", claimId: nil),
            ReplyRule(text: "Skip the pleasantries with Juno.", claimId: "clm_b2"),
        ])
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: try XCTUnwrap(style.updated))
        XCTAssertEqual([parts.year, parts.month, parts.day], [2026, 10, 24])
    }

    func testAFileWithoutAHeaderStillWorks() {
        let style = LearnedReplyStyle.parse("- One. [claim:x]\n- Two.\n")
        XCTAssertEqual(style.rules, [ReplyRule(text: "One.", claimId: "x"), ReplyRule(text: "Two.", claimId: nil)])
        XCTAssertNil(style.updated)
    }

    func testAFileWithNoBulletsReadsItsPlainLines() {
        XCTAssertEqual(LearnedReplyStyle.parse("# Title\nBe brief. [claim:z]").rules, [ReplyRule(text: "Be brief.", claimId: "z")])
    }
}
