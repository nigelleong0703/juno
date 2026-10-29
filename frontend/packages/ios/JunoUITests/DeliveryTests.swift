import XCTest

/// Live (opt-in via TEST_RUNNER_JUNO_*): what the chat says about a message after Send. Opens the agent named
/// JUNO_DELIVERY_AGENT, sends JUNO_DELIVERY_TEXT and screenshots the status line over time ("SHOT|name|path").
/// With JUNO_DELIVERY_EXPECT_FAIL=1 (host stopped the backend first) it waits for "Not sent" instead.
@MainActor
final class DeliveryTests: XCTestCase {
    func testDeliveryStates() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["JUNO_SERVER"], let name = env["JUNO_DELIVERY_AGENT"], let text = env["JUNO_DELIVERY_TEXT"] else {
            throw XCTSkip("JUNO_* / JUNO_DELIVERY_* not set")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-onboarding", "NO", "-server", server, "-open", "", "-tab", "", "-sheet", "", "-draft", ""]
        app.launch()
        func shot(_ n: String) {
            let url = URL(fileURLWithPath: NSTemporaryDirectory()).appending(path: "\(n).png")
            try? XCUIScreen.main.screenshot().pngRepresentation.write(to: url)
            print("SHOT|\(n)|\(url.path)")
        }
        let card = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "\(name)")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 20)); card.tap()
        let field = app.textFields["Message…"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap(); field.typeText(text)
        app.buttons["Send"].tap()
        if env["JUNO_DELIVERY_EXPECT_FAIL"] == "1" {
            let failed = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Not sent'")).firstMatch
            XCTAssertTrue(failed.waitForExistence(timeout: 30))
            Thread.sleep(forTimeInterval: 1)
            shot("d-failed")
            return
        }
        Thread.sleep(forTimeInterval: 0.6); shot("d-1")
        Thread.sleep(forTimeInterval: 2.5); shot("d-2")
        Thread.sleep(forTimeInterval: 8); shot("d-3")
        Thread.sleep(forTimeInterval: 15); shot("d-4")
    }
}
