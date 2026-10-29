import XCTest

/// Screenshots of onboarding and sign-in (opt-in: TEST_RUNNER_JUNO_SHOTS=<dir>; TEST_RUNNER_JUNO_SHOT_SUFFIX=light|dark).
@MainActor
final class OnboardingTourTests: XCTestCase {
    func testTour() throws {
        let env = ProcessInfo.processInfo.environment
        guard let dir = env["JUNO_SHOTS"] else { throw XCTSkip("JUNO_SHOTS not set") }
        let suffix = env["JUNO_SHOT_SUFFIX"] ?? "light"
        let app = XCUIApplication()
        app.launchArguments = ["-onboarding", "YES", "-email", "", "-open", "", "-tab", "", "-sheet", "", "-draft", ""]
        app.launch()
        func shot(_ name: String, wait: TimeInterval = 1.2) {
            Thread.sleep(forTimeInterval: wait)
            try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(dir)/onboarding-\(name)-\(suffix).png"))
        }
        XCTAssertTrue(app.buttons["Continue"].waitForExistence(timeout: 10))
        shot("page1", wait: 2)
        app.buttons["Continue"].tap(); shot("page2", wait: 1.5)
        app.buttons["Continue"].tap(); shot("page3", wait: 1.5)
        app.buttons["Get started"].tap()
        XCTAssertTrue(app.buttons["Log in"].waitForExistence(timeout: 5))
        shot("login", wait: 1.5)
        app.buttons["Create account"].tap()
        // The simulator's first-run "slide to type" sheet covers the keyboard once.
        if app.buttons["Continue"].waitForExistence(timeout: 3) { app.buttons["Continue"].tap() }
        shot("signup", wait: 1.5)
        app.buttons["Back"].tap()
        app.buttons["Log in"].tap()
        let email = app.textFields["Email"]
        email.tap()
        shot("login-keyboard", wait: 1.5)
        email.typeText("someone@example.com")
        let pw = app.secureTextFields["Password"]
        pw.tap(); pw.typeText("not-the-password\n")
        shot("login-error", wait: 5)
        app.buttons["Server"].tap()
        shot("login-server", wait: 1.5)
    }
}
