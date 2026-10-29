import XCTest

/// Live (opt-in, TEST_RUNNER_JUNO_SERVER / _EMAIL / _PASSWORD): an account whose agent has pending requests of every kind,
/// tasks and a standing grant (seeded straight into the dev database). Screenshots the request cards in the chat, the
/// secure-input sheet, and the agent profile's Activity and Permissions tabs ("SHOT|name|path").
@MainActor
final class RequestCardsTests: XCTestCase {
    private func shot(_ name: String) {
        Thread.sleep(forTimeInterval: 0.8)
        let url = URL(fileURLWithPath: NSTemporaryDirectory()).appending(path: "\(name).png")
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: url)
        print("SHOT|\(name)|\(url.path)")
    }

    func testCardsAndProfile() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["JUNO_SERVER"], let email = env["JUNO_EMAIL"], let password = env["JUNO_PASSWORD"] else {
            throw XCTSkip("JUNO_SERVER / JUNO_EMAIL / JUNO_PASSWORD not set")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-onboarding", "NO", "-server", server, "-email", email, "-open", "", "-tab", "", "-sheet", "", "-draft", "", "-sidebar", "NO"]
        app.launch()
        if app.buttons["Log in"].waitForExistence(timeout: 6) {
            app.buttons["Log in"].tap()
            XCTAssertTrue(app.textFields["Email"].waitForExistence(timeout: 5))
            app.secureTextFields["Password"].tap(); app.secureTextFields["Password"].typeText(password + "\n")
            let notNow = app.buttons["Not Now"]
            if notNow.waitForExistence(timeout: 6) { notNow.tap() }
        }
        let chatTab = app.tabBars.buttons["Chat"]
        XCTAssertTrue(chatTab.waitForExistence(timeout: 20))
        chatTab.tap()
        let chat = app.staticTexts["Iris"].firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 15))
        chat.tap()
        XCTAssertTrue(app.textFields["Message…"].firstMatch.waitForExistence(timeout: 20))
        Thread.sleep(forTimeInterval: 3)
        shot("p2-chat-bottom")
        // Scroll up through the cards, one screen at a time.
        for i in 1...5 {
            app.swipeDown(velocity: .slow)
            app.swipeDown(velocity: .slow)
            shot("p2-chat-up\(i)")
        }
        for _ in 1...12 { app.swipeUp(velocity: .fast) }
        // Secure input: the card's button opens the native sheet.
        let secure = app.buttons["secure-primary"]
        for _ in 0..<6 where !secure.isHittable { app.swipeDown(velocity: .slow) }
        if secure.isHittable {
            secure.tap()
            XCTAssertTrue(app.buttons["secure-submit"].waitForExistence(timeout: 6))
            shot("p2-secure-sheet")
            let field = app.secureTextFields["secure-field-f1"]
            if field.waitForExistence(timeout: 3) { field.tap(); field.typeText("hunter2hunter2") }
            shot("p2-secure-sheet-filled")
            app.buttons["Close"].firstMatch.tap()
        }
        // Agent profile: Activity and Permissions.
        for _ in 1...12 { app.swipeDown(velocity: .fast) }
        let card = app.buttons["Iris card"].firstMatch
        if card.waitForExistence(timeout: 5) { card.tap() }
        XCTAssertTrue(app.buttons["Edit agent"].waitForExistence(timeout: 8))
        shot("p2-profile-activity")
        app.buttons["agent-profile-tab-approvals"].tap()
        Thread.sleep(forTimeInterval: 2)
        shot("p2-profile-permissions")
        app.swipeUp()
        shot("p2-profile-permissions-2")
        for _ in 0..<6 { app.swipeUp() }
        shot("p2-profile-permissions-3")
        for _ in 0..<3 { app.swipeUp() }
        shot("p2-profile-permissions-4")
    }
}
