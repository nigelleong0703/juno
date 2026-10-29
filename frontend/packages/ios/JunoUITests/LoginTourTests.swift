import XCTest

/// Screenshots of the sign-in flow (opt-in like LiveBackendTests). Each shot is written to the runner's
/// temp dir and its path printed as "SHOT|name|path" so the host can collect them.
@MainActor
final class LoginTourTests: XCTestCase {
    func testLoginTour() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["JUNO_SERVER"], let email = env["JUNO_EMAIL"], let password = env["JUNO_PASSWORD"] else {
            throw XCTSkip("JUNO_SERVER / JUNO_EMAIL / JUNO_PASSWORD not set")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-onboarding", "NO", "-open", "", "-tab", "", "-sheet", "", "-draft", ""]
        app.launch()
        func shot(_ name: String) {
            Thread.sleep(forTimeInterval: 1.2)
            let url = URL(fileURLWithPath: NSTemporaryDirectory()).appending(path: "\(name).png")
            try? XCUIScreen.main.screenshot().pngRepresentation.write(to: url)
            print("SHOT|\(name)|\(url.path)")
        }

        let enter = app.buttons["Log in"]
        XCTAssertTrue(enter.waitForExistence(timeout: 8), "expected the sign-in screen (sign out first)")
        shot("1-welcome")
        enter.tap()
        shot("2-form")
        if server != "http://127.0.0.1:8787" {
            app.buttons["Server"].tap()
            let field = app.textFields["Server address"]
            field.tap()
            if let v = field.value as? String, !v.isEmpty { field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: v.count)) }
            field.typeText(server)
        }
        let emailField = app.textFields["Email"]
        emailField.tap()
        if let v = emailField.value as? String, v.isEmpty || v == "you@example.com" { emailField.typeText(email) }
        app.secureTextFields["Password"].tap(); app.secureTextFields["Password"].typeText(password)
        shot("3-filled")
        app.buttons.matching(identifier: "Log in").allElementsBoundByIndex.last { $0.isHittable }?.tap()
        let notNow = app.buttons["Not Now"]
        if notNow.waitForExistence(timeout: 8) { shot("4-save-password"); notNow.tap() }
        // Signed in: the app opens on the Chat tab (Today header over the list).
        XCTAssertTrue(app.tabBars.buttons["Chat"].waitForExistence(timeout: 20))
        shot("5-signed-in-home")
        app.tabBars.buttons["Chat"].tap()
        shot("6-chat-list")
        let more = app.tabBars.buttons["More"]
        if !more.exists { app.swipeDown(velocity: .fast) }
        more.tap()
        shot("7-account")
        app.buttons["Sign out"].tap()
        XCTAssertTrue(enter.waitForExistence(timeout: 8))
        shot("8-signed-out")
    }
}
