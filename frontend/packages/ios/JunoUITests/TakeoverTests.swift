import XCTest

/// Live take-over walk (opt-in via TEST_RUNNER_JUNO_*): workspace → Take over → type on the remote → hand back.
/// Prints "SHOT|name|path" and "MARK|name|epoch" so a host recording can be cut at each transition.
@MainActor
final class TakeoverTests: XCTestCase {
    func testTakeover() throws {
        guard ProcessInfo.processInfo.environment["JUNO_SERVER"] != nil else { throw XCTSkip("JUNO_* not set") }
        let app = XCUIApplication()
        app.launchArguments = ["-onboarding", "NO", "-open", "cvn-1f4dbfb72f615918e344e0da", "-tab", "", "-sheet", "workspace", "-section", "computer", "-draft", ""]
        app.launch()
        func mark(_ n: String) { print("MARK|\(n)|\(Date().timeIntervalSince1970)") }
        func shot(_ name: String) {
            let url = URL(fileURLWithPath: NSTemporaryDirectory()).appending(path: "\(name).png")
            try? XCUIScreen.main.screenshot().pngRepresentation.write(to: url)
            print("SHOT|\(name)|\(url.path)")
        }
        let take = app.buttons["Take over"]
        XCTAssertTrue(take.waitForExistence(timeout: 15))
        Thread.sleep(forTimeInterval: 4)
        shot("k1-watching")
        mark("tap-takeover"); take.tap()
        Thread.sleep(forTimeInterval: 6)
        shot("k2-control")
        Thread.sleep(forTimeInterval: 1.5)
        mark("typing")
        app.typeText("hello from the phone")
        Thread.sleep(forTimeInterval: 2)
        shot("k3-typed")
        app.buttons["Hide keyboard"].firstMatch.tap()
        Thread.sleep(forTimeInterval: 1)
        XCTAssertEqual(app.keyboards.count, 0, "keyboard should hide from the accessory bar")
        mark("tap-handback"); app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Hand control back'")).firstMatch.tap()
        Thread.sleep(forTimeInterval: 3)
        shot("k4-handed-back")
    }
}
