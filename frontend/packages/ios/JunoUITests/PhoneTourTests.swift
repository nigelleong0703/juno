import XCTest

/// Live tour for a real phone (opt-in via TEST_RUNNER_JUNO_*): Home → an agent's chat → send → status pill →
/// agent card → another agent's computer. Screenshots are kept as attachments in the result bundle.
@MainActor
final class PhoneTourTests: XCTestCase {
    func testTour() throws {
        let env = ProcessInfo.processInfo.environment
        guard let email = env["JUNO_EMAIL"], let password = env["JUNO_PASSWORD"] else { throw XCTSkip("JUNO_* not set") }
        let chatAgent = env["JUNO_TOUR_AGENT"] ?? "Milo", screenAgent = env["JUNO_TOUR_SCREEN_AGENT"] ?? "Iris"
        let app = XCUIApplication()
        app.launchArguments = ["-onboarding", "NO", "-open", "", "-tab", "", "-sheet", "", "-draft", ""]
        app.launch()
        func shot(_ name: String) {
            let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            a.name = name; a.lifetime = .keepAlways; add(a)
        }
        if app.buttons["Log in"].waitForExistence(timeout: 5) {
            app.buttons["Log in"].tap()
            let e = app.textFields["Email"]; XCTAssertTrue(e.waitForExistence(timeout: 5))
            e.tap(); if let v = e.value as? String, v.isEmpty || v == "you@example.com" { e.typeText(email) }
            app.secureTextFields["Password"].tap(); app.secureTextFields["Password"].typeText(password + "\n")
            if app.buttons["Not Now"].waitForExistence(timeout: 8) { app.buttons["Not Now"].tap() }
        }
        let card = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "\(chatAgent)")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 25))
        Thread.sleep(forTimeInterval: 1.5); shot("1-home")
        card.tap()
        let field = app.textFields["Message…"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 2); shot("2-chat")
        field.tap(); field.typeText("Hi from my phone! One sentence: what should I cook tonight?")
        app.buttons["Send"].tap()
        Thread.sleep(forTimeInterval: 1.2); shot("3-sent-pill")
        Thread.sleep(forTimeInterval: 5); shot("4-working")
        Thread.sleep(forTimeInterval: 15); shot("5-reply")
        // Agent card from the header figure.
        app.buttons.matching(NSPredicate(format: "label ENDSWITH 'card'")).firstMatch.tap()
        Thread.sleep(forTimeInterval: 2); shot("6-agent-card")
        app.swipeDown(velocity: .fast); Thread.sleep(forTimeInterval: 1)
        // Back to Home, then the other agent's computer.
        app.navigationBars.buttons.firstMatch.tap(); Thread.sleep(forTimeInterval: 1)
        app.tabBars.buttons["Chat"].tap(); Thread.sleep(forTimeInterval: 1)
        let other = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "\(screenAgent)")).firstMatch
        if other.waitForExistence(timeout: 5) {
            other.tap(); Thread.sleep(forTimeInterval: 2)
            app.navigationBars.buttons["Computer"].firstMatch.tap()
            Thread.sleep(forTimeInterval: 8); shot("7-computer")
        }
    }
}
