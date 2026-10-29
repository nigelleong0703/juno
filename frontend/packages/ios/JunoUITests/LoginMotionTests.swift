import XCTest

/// Drives the welcome ⇄ form morph slowly so a Simulator recording shows the transition.
@MainActor
final class LoginMotionTests: XCTestCase {
    func testMorph() {
        let app = XCUIApplication()
        app.launchArguments = ["-onboarding", "NO", "-open", "", "-tab", "", "-sheet", "", "-draft", ""]
        app.launch()
        XCTAssertTrue(app.buttons["Log in"].waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 2.5)
        print("MARK|tap-login|\(Date().timeIntervalSince1970)")
        app.buttons["Log in"].tap()
        Thread.sleep(forTimeInterval: 2.5)
        print("MARK|tap-back|\(Date().timeIntervalSince1970)")
        app.buttons["Back"].tap()
        Thread.sleep(forTimeInterval: 2.0)
        app.buttons["Create account"].tap()
        Thread.sleep(forTimeInterval: 2.0)
    }
}
