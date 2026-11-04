import XCTest
@testable import Juno

/// A platform group's settings change on screen at once and go back when the save fails; the approval card names who asked only when someone other than the owner did.
@MainActor
final class GroupSettingsTests: XCTestCase {
    private struct Offline: Error {}

    private func settings(speak: Bool = false, delegated: [String] = []) -> Contract.GroupSettings {
        Contract.GroupSettings(platform: "slack", title: "Design team", observes: true, speak: speak, delegated: delegated, backfill: nil)
    }

    func testAChangeShowsAtOnceAndTheServersAnswerReplacesIt() async {
        var sent: [GroupSettingsModel.Change] = []
        var server = settings()
        let model = GroupSettingsModel(load: { server }, save: { change in
            sent.append(change)
            if let speak = change.speak { server.speak = speak }
            if let delegated = change.delegated { server.delegated = delegated }
            return server
        })
        await model.refresh()
        await model.apply(.init(speak: true))
        await model.toggle("spending")
        await model.toggle("public")
        await model.toggle("spending")
        XCTAssertEqual(model.settings?.speak, true)
        XCTAssertEqual(model.settings?.delegated, ["public"])
        XCTAssertEqual(sent.last?.delegated, ["public"])
        XCTAssertFalse(model.failed)
    }

    func testAFailedSavePutsTheOldSettingsBack() async {
        let model = GroupSettingsModel(load: { self.settings(delegated: ["sharing"]) }, save: { _ in throw Offline() })
        await model.refresh()
        await model.toggle("spending")
        XCTAssertEqual(model.settings?.delegated, ["sharing"])
        XCTAssertTrue(model.failed)
    }

    func testWhoAskedShowsOnlyForSomeoneOtherThanTheOwner() {
        XCTAssertNil(GroupWords.askedBy(nil))
        XCTAssertEqual(GroupWords.askedBy(.init(name: "Mia", where: "Design team", kind: "teammate")), "Mia asked in Design team")
        XCTAssertEqual(GroupWords.askedBy(.init(name: nil, where: nil, kind: "stranger")), "Someone outside the team asked")
        XCTAssertEqual(GroupWords.askedBy(.init(name: "Sam", where: "#ops", kind: "stranger")), "Sam, someone outside the team, asked in #ops")
    }
}
