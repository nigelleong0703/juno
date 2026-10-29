import XCTest

/// Live (opt-in via TEST_RUNNER_JUNO_*): screenshots of the Chat tab, an agent's chat and its computer. SHOT lines.
@MainActor
final class ScreenTourTests: XCTestCase {
    func testTour() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["JUNO_SERVER"], let email = env["JUNO_EMAIL"], let password = env["JUNO_PASSWORD"] else { throw XCTSkip("JUNO_* not set") }
        let agent = env["JUNO_TOUR_AGENT"] ?? "Iris"
        let app = XCUIApplication()
        app.launchArguments = ["-onboarding", "NO", "-server", server, "-open", "", "-tab", "chat", "-sheet", "", "-draft", "", "-sidebar", "NO"]
        app.launch()
        func shot(_ n: String) {
            let url = URL(fileURLWithPath: NSTemporaryDirectory()).appending(path: "\(n).png")
            try? XCUIScreen.main.screenshot().pngRepresentation.write(to: url)
            print("SHOT|\(n)|\(url.path)")
        }
        if app.buttons["Log in"].waitForExistence(timeout: 6) {
            app.buttons["Log in"].tap()
            let e = app.textFields["Email"]; XCTAssertTrue(e.waitForExistence(timeout: 5))
            e.tap(); if let v = e.value as? String, v.isEmpty || v == "you@example.com" { e.typeText(email) }
            app.secureTextFields["Password"].tap(); app.secureTextFields["Password"].typeText(password + "\n")
            if app.buttons["Not Now"].waitForExistence(timeout: 8) { app.buttons["Not Now"].tap() }
        }
        let tile = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", agent))
        XCTAssertTrue(tile.firstMatch.waitForExistence(timeout: 25))
        Thread.sleep(forTimeInterval: 3); shot("tour-1-home")
        tile.allElementsBoundByIndex.first { $0.isHittable }?.tap()
        XCTAssertTrue(app.textFields["Message…"].firstMatch.waitForExistence(timeout: 15))
        Thread.sleep(forTimeInterval: 3); shot("tour-2-chat")
        app.buttons["Computer"].firstMatch.tap()
        Thread.sleep(forTimeInterval: 10); shot("tour-3-computer")
    }
}
