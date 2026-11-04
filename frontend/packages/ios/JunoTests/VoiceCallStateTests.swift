import XCTest
@testable import Juno

final class VoiceCallStateTests: XCTestCase {
    func testAgentStateMapping() {
        XCTAssertEqual(VoiceCallState.agent("initializing"), .connecting)
        XCTAssertEqual(VoiceCallState.agent("idle"), .connecting)
        XCTAssertEqual(VoiceCallState.agent("listening"), .listening)
        XCTAssertEqual(VoiceCallState.agent("thinking"), .thinking)
        XCTAssertEqual(VoiceCallState.agent("speaking"), .speaking)
        XCTAssertNil(VoiceCallState.agent("something-new"))
    }

    func testSmootherRisesFastFallsSlowlyAndClamps() {
        var smoother = VoiceLevelSmoother()
        let rise = smoother.push(1)
        XCTAssertEqual(rise, 0.55, accuracy: 0.001)
        let fall = smoother.push(0)
        XCTAssertEqual(fall, 0.55 * 0.85, accuracy: 0.001)
        XCTAssertLessThanOrEqual(smoother.push(5), 1)
        for _ in 0..<80 { smoother.push(0) }
        XCTAssertEqual(smoother.value, 0)
    }

    func testNormalizedRmsMapsDecibelRange() {
        XCTAssertEqual(VoiceLevelSmoother.normalized(rms: 0), 0)
        XCTAssertEqual(VoiceLevelSmoother.normalized(rms: 0.1), 0.75, accuracy: 0.01)
        XCTAssertEqual(VoiceLevelSmoother.normalized(rms: 1), 1)
    }
}

final class VoiceCallTimelineTests: XCTestCase {
    func testPhasesRecordOnceAndNeverGoBackwards() async throws {
        var timeline = VoiceCallTimeline()
        XCTAssertNotNil(timeline.mark(.appeared))
        try await Task.sleep(for: .milliseconds(20))
        let permission = try XCTUnwrap(timeline.mark(.permission))
        XCTAssertGreaterThanOrEqual(permission, 15)
        XCTAssertNil(timeline.mark(.permission))
        XCTAssertEqual(timeline.marks[.permission], permission)
        XCTAssertTrue(timeline.summary.hasPrefix("appeared="))
        XCTAssertTrue(timeline.summary.contains("permission=\(permission)ms"))
    }
}
