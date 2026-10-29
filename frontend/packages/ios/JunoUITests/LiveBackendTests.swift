import XCTest

/// Signs in to a real backend and sends a message. Opt-in: set TEST_RUNNER_JUNO_SERVER / _EMAIL / _PASSWORD
/// (xcodebuild passes TEST_RUNNER_* through as JUNO_*); skipped otherwise.
@MainActor
final class LiveBackendTests: XCTestCase {
    func testSignInAndChat() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["JUNO_SERVER"], let email = env["JUNO_EMAIL"], let password = env["JUNO_PASSWORD"] else {
            throw XCTSkip("JUNO_SERVER / JUNO_EMAIL / JUNO_PASSWORD not set")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-onboarding", "NO", "-server", server, "-open", "", "-tab", "", "-sheet", "", "-draft", ""]
        app.launch()

        // A session restored from the Keychain skips the login screen. The server comes from `-server`.
        if app.buttons["Log in"].waitForExistence(timeout: 6) {
            app.buttons["Log in"].tap()
            let e = app.textFields["Email"]; XCTAssertTrue(e.waitForExistence(timeout: 5))
            e.tap(); if let v = e.value as? String, v.isEmpty || v == "you@example.com" { e.typeText(email) }
            app.secureTextFields["Password"].tap(); app.secureTextFields["Password"].typeText(password + "\n")
            print("STEP|signed-in-tapped")
            // iOS offers to save the password; decline so it doesn't cover the chat.
            let notNow = app.buttons["Not Now"]
            if notNow.waitForExistence(timeout: 6) { notNow.tap() }
        }
        // The app opens on Chat; open the most recent chat from the Chat tab.
        let chatTab = app.tabBars.buttons["Chat"]
        XCTAssertTrue(chatTab.waitForExistence(timeout: 20), "home did not open after sign-in")
        chatTab.tap()
        app.cells.firstMatch.tap()
        let message = app.textFields["Message…"].firstMatch
        XCTAssertTrue(message.waitForExistence(timeout: 20), "chat did not open after sign-in")
        print("STEP|chat-open")
        message.tap()
        message.typeText("Hi! Reply with one short sentence.")
        app.buttons["Send"].tap()
        print("STEP|sent")
        // Wait for the agent's reply to arrive over SSE.
        let reply = app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] 'Working' OR label CONTAINS[c] 'Worked'")).firstMatch
        _ = reply.waitForExistence(timeout: 60)
        Thread.sleep(forTimeInterval: 20)
        print("STEP|done")
    }
}
