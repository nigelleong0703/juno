import XCTest
@testable import Juno

final class VoiceTranscriptTests: XCTestCase {
    func testUpdatesReplaceSegmentsAndIgnoreLateInterim() {
        var transcript = VoiceTranscript()
        transcript.update(segmentID: "1", participantIdentity: "me", localIdentity: "me", text: "你", isFinal: false)
        transcript.update(segmentID: "1", participantIdentity: "me", localIdentity: "me", text: "你好", isFinal: true)
        transcript.update(segmentID: "1", participantIdentity: "me", localIdentity: "me", text: "你", isFinal: false)
        transcript.update(segmentID: "1", participantIdentity: "agent", localIdentity: "me", text: "你好！", isFinal: true)
        XCTAssertEqual(transcript.turns.count, 2)
        XCTAssertEqual(transcript.turns.map(\.text), ["你好", "你好！"])
        XCTAssertEqual(transcript.turns.map(\.isUser), [true, false])
        XCTAssertTrue(transcript.turns[0].isFinal)
    }

    func testInvalidUpdatesDoNotCreateTurns() {
        var transcript = VoiceTranscript()
        transcript.update(segmentID: "", participantIdentity: "me", localIdentity: "me", text: "hello", isFinal: true)
        transcript.update(segmentID: "1", participantIdentity: "", localIdentity: "me", text: "hello", isFinal: true)
        transcript.update(segmentID: "1", participantIdentity: "me", localIdentity: "me", text: "", isFinal: false)
        XCTAssertTrue(transcript.turns.isEmpty)
    }
}

final class VoiceCallReadinessTests: XCTestCase {
    func testActiveAgentStatesMeanTheWorkerCanHear() {
        XCTAssertTrue(VoiceCallController.agentStateIsReady("listening"))
        XCTAssertTrue(VoiceCallController.agentStateIsReady("thinking"))
        XCTAssertTrue(VoiceCallController.agentStateIsReady("speaking"))
    }

    func testStatesBeforeTheWorkerListensAreNotReady() {
        XCTAssertFalse(VoiceCallController.agentStateIsReady("initializing"))
        XCTAssertFalse(VoiceCallController.agentStateIsReady("idle"))
        XCTAssertFalse(VoiceCallController.agentStateIsReady("something-new"))
        XCTAssertFalse(VoiceCallController.agentStateIsReady(""))
    }
}
