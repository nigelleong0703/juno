import XCTest

/// Push banners end to end on the simulator, against a live backend (opt-in like LiveBackendTests: set
/// TEST_RUNNER_JUNO_SERVER / _EMAIL / _PASSWORD). The test signs in, accepts the notification prompt, and goes
/// to the background. The driver script then runs `xcrun simctl push` (STEP|ready / STEP|ready2 in the log) and
/// the test taps the banner from SpringBoard: a requestId opens the Needs-you queue, a conversationId opens the chat.
@MainActor
final class PushTests: XCTestCase {
    func testBannerTapRoutesRequestAndConversation() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["JUNO_SERVER"], let email = env["JUNO_EMAIL"], let password = env["JUNO_PASSWORD"] else {
            throw XCTSkip("JUNO_SERVER / JUNO_EMAIL / JUNO_PASSWORD not set")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-onboarding", "NO", "-server", server, "-open", "", "-tab", "", "-sheet", "", "-draft", ""]
        // The notification prompt is a system alert over the app: accept it whenever it appears.
        let monitor = addUIInterruptionMonitor(withDescription: "Notifications") { alert in
            guard alert.buttons["Allow"].exists else { return false }
            alert.buttons["Allow"].tap()
            print("STEP|notifications-allowed")
            return true
        }
        app.launch()

        if app.buttons["Log in"].waitForExistence(timeout: 6) {
            app.buttons["Log in"].tap()
            let e = app.textFields["Email"]; XCTAssertTrue(e.waitForExistence(timeout: 5))
            e.tap(); if let v = e.value as? String, v.isEmpty || v == "you@example.com" { e.typeText(email) }
            app.secureTextFields["Password"].tap(); app.secureTextFields["Password"].typeText(password + "\n")
            let notNow = app.buttons["Not Now"]
            if notNow.waitForExistence(timeout: 6) { notNow.tap() }
        }
        let homeTab = app.tabBars.buttons["Chat"]
        XCTAssertTrue(homeTab.waitForExistence(timeout: 20), "home did not open after sign-in")
        // The prompt only shows after sign-in; a tap gives the interruption monitor a chance to fire.
        app.swipeUp()
        app.tap()
        print("STEP|signed-in")

        XCUIDevice.shared.press(.home)
        print("STEP|ready")
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let banner = springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Iris needs you'")).firstMatch
        if banner.waitForExistence(timeout: 60) {
            print("STEP|banner-request-seen")
            banner.tap()
        } else {
            XCTFail("request banner did not appear")
        }
        XCTAssertTrue(app.navigationBars["Needs you"].waitForExistence(timeout: 20), "tap did not open the Needs-you queue")
        print("STEP|queue-open")
        removeUIInterruptionMonitor(monitor)

        XCUIDevice.shared.press(.home)
        print("STEP|ready2")
        let conversation = springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Iris finished'")).firstMatch
        if conversation.waitForExistence(timeout: 60) {
            print("STEP|banner-run-seen")
            conversation.tap()
        } else {
            XCTFail("run banner did not appear")
        }
        XCTAssertTrue(app.textFields["Message…"].firstMatch.waitForExistence(timeout: 20), "tap did not open the chat")
        print("STEP|chat-open")
    }
}
