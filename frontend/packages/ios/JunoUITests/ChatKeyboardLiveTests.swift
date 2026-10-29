import XCTest

/// Live (opt-in via TEST_RUNNER_JUNO_SERVER / _EMAIL / _PASSWORD and a chat named JUNO_KEYBOARD_AGENT, default "Kira", with
/// 30+ messages): the interactive keyboard dismissal. Run with TEST_RUNNER_JUNO_CHAT_MOTION_TRACE=1 to record the frames
/// (caches/juno-chat-motion/latest.json is overwritten by each gesture, so run one test at a time). SHOT lines.
@MainActor
final class ChatKeyboardLiveTests: XCTestCase {
    private func shot(_ name: String) {
        let url = URL(fileURLWithPath: NSTemporaryDirectory()).appending(path: "\(name).png")
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: url)
        print("SHOT|\(name)|\(url.path)")
    }

    private func openChat() throws -> (XCUIApplication, XCUIElement) {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["JUNO_SERVER"], let email = env["JUNO_EMAIL"], let password = env["JUNO_PASSWORD"] else {
            throw XCTSkip("JUNO_SERVER / JUNO_EMAIL / JUNO_PASSWORD not set")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-onboarding", "NO", "-server", server, "-email", email, "-open", "", "-tab", "", "-sheet", "", "-draft", ""]
        if env["JUNO_CHAT_MOTION_TRACE"] == "1" { app.launchEnvironment["JUNO_CHAT_MOTION_TRACE"] = "1" }
        app.launch()
        if app.buttons["Log in"].waitForExistence(timeout: 6) {
            app.buttons["Log in"].tap()
            XCTAssertTrue(app.textFields["Email"].waitForExistence(timeout: 5))
            app.secureTextFields["Password"].tap(); app.secureTextFields["Password"].typeText(password + "\n")
            if app.buttons["Not Now"].waitForExistence(timeout: 6) { app.buttons["Not Now"].tap() }
        }
        let chatTab = app.tabBars.buttons["Chat"]
        XCTAssertTrue(chatTab.waitForExistence(timeout: 20))
        chatTab.tap()
        let chat = app.staticTexts[env["JUNO_KEYBOARD_AGENT"] ?? "Kira"].firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 15))
        chat.tap()
        let field = app.textFields["Message…"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 2)
        field.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 1)
        return (app, field)
    }

    private func point(_ app: XCUIApplication, y: CGFloat) -> XCUICoordinate {
        let window = app.windows.firstMatch.frame
        return app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: window.width / 2, dy: y))
    }

    private func settled(_ app: XCUIApplication) { Thread.sleep(forTimeInterval: 1.6) }

    /// Slow drag from the list to just inside the composer, held, then released: the keyboard stays.
    func testSlowDragKeepsKeyboard() throws {
        let (app, field) = try openChat()
        let top = field.frame.minY
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.2) { MainActor.assumeIsolated { self.shot("kb-a-mid-drag") } }
        point(app, y: top - 250).press(forDuration: 0.1, thenDragTo: point(app, y: top + 30), withVelocity: .slow, thenHoldForDuration: 1.2)
        settled(app)
        shot("kb-a-after")
        XCTAssertTrue(app.keyboards.firstMatch.exists, "a slow drag that was not released at the bottom keeps the keyboard")
    }

    /// Fast flick down past the composer: the keyboard goes.
    func testFastFlickDismissesKeyboard() throws {
        let (app, field) = try openChat()
        let top = field.frame.minY
        point(app, y: top - 250).press(forDuration: 0.05, thenDragTo: point(app, y: top + 330), withVelocity: .fast, thenHoldForDuration: 0)
        settled(app)
        shot("kb-b-after")
        XCTAssertFalse(app.keyboards.firstMatch.exists, "a flick released over the keyboard dismisses it")
    }

    /// Dragged all the way to the bottom and held: dismissed by position; then the composer opens it again.
    func testDragToBottomDismissesThenComposerReopens() throws {
        let (app, field) = try openChat()
        let top = field.frame.minY
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.2) { MainActor.assumeIsolated { self.shot("kb-c-mid-drag") } }
        point(app, y: top - 250).press(forDuration: 0.1, thenDragTo: point(app, y: top + 360), withVelocity: .slow, thenHoldForDuration: 1.0)
        settled(app)
        shot("kb-c-after")
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        app.textFields["Message…"].firstMatch.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 1); shot("kb-c-reopened")
    }
}
