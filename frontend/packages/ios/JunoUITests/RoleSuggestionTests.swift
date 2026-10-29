import XCTest

/// Live (opt-in via TEST_RUNNER_JUNO_*): an agent with a pending role suggestion shows the confirm card in its chat
/// transcript. Leaves it pending (no tap) so the suggestion stays on the server. Prints "SHOT|name|path".
@MainActor
final class RoleSuggestionTests: XCTestCase {
    func testPromptShows() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["JUNO_SERVER"], let email = env["JUNO_EMAIL"], let password = env["JUNO_PASSWORD"],
              let name = env["JUNO_SUGGESTED_AGENT"] else { throw XCTSkip("JUNO_* / JUNO_SUGGESTED_AGENT not set") }
        let app = XCUIApplication()
        app.launchArguments = ["-onboarding", "NO", "-server", server, "-open", "", "-tab", "", "-sheet", "", "-draft", ""]
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
        let card = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "\(name)")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 20)); card.tap()
        let use = app.buttons["Use this role"]
        XCTAssertTrue(use.waitForExistence(timeout: 15), "the role card should be in the chat")
        // The card sits where the suggestion was made; scroll up to it if later replies pushed it off screen.
        var tries = 0
        while !use.isHittable && tries < 8 { app.swipeDown(velocity: .slow); tries += 1 }
        app.swipeUp(velocity: .slow); if !use.isHittable { app.swipeDown(velocity: .slow) }
        Thread.sleep(forTimeInterval: 1)
        shot("role-card")
    }
}
