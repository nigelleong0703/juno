import XCTest

/// Live backend tour of runs/steps/tasks (opt-in via TEST_RUNNER_JUNO_*): screenshots as "SHOT|name|path".
@MainActor
final class LiveTasksTests: XCTestCase {
    func testTasks() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["JUNO_SERVER"], let email = env["JUNO_EMAIL"], let password = env["JUNO_PASSWORD"] else {
            throw XCTSkip("JUNO_* not set")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-onboarding", "NO", "-server", server, "-open", "", "-tab", "", "-sheet", "", "-draft", ""]
        app.launch()
        func shot(_ name: String) {
            Thread.sleep(forTimeInterval: 1.5)
            let url = URL(fileURLWithPath: NSTemporaryDirectory()).appending(path: "\(name).png")
            try? XCUIScreen.main.screenshot().pngRepresentation.write(to: url)
            print("SHOT|\(name)|\(url.path)")
        }
        if app.buttons["Log in"].waitForExistence(timeout: 6) {
            app.buttons["Log in"].tap()
            let e = app.textFields["Email"]; XCTAssertTrue(e.waitForExistence(timeout: 5))
            e.tap(); if let v = e.value as? String, v.isEmpty || v == "you@example.com" { e.typeText(email) }
            app.secureTextFields["Password"].tap(); app.secureTextFields["Password"].typeText(password + "\n")
            if app.buttons["Not Now"].waitForExistence(timeout: 8) { app.buttons["Not Now"].tap() }
        }
        // Chat tab: Iris's row opens its chat.
        let iris = app.cells.containing(NSPredicate(format: "label CONTAINS 'Iris'")).firstMatch
        XCTAssertTrue(iris.waitForExistence(timeout: 20)); iris.tap()
        XCTAssertTrue(app.textFields["Message…"].firstMatch.waitForExistence(timeout: 20))
        Thread.sleep(forTimeInterval: 3)
        shot("t1-chat")
        let blocked = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Lisbon'")).firstMatch
        if blocked.waitForExistence(timeout: 3) { blocked.tap(); shot("t2-steps") }
        app.navigationBars.buttons["Computer"].firstMatch.tap()
        Thread.sleep(forTimeInterval: 6) // ticket + VNC handshake
        shot("t3-computer")
        print("MARK|live-ready|\(Date().timeIntervalSince1970)")
        Thread.sleep(forTimeInterval: 8) // host moves things on the screen meanwhile
        shot("t3b-computer-after")
        app.terminate()
        app.launchArguments = ["-onboarding", "NO", "-server", server, "-open", "", "-tab", "", "-sheet", "workspace", "-section", "progress", "-draft", ""]
        app.launch()
        Thread.sleep(forTimeInterval: 4)
        shot("t4-progress")
    }
}
