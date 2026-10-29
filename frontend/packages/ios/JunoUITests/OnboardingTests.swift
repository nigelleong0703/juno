import XCTest

/// First launch shows the onboarding; Skip leads to the login screen; the next launch goes straight to login.
@MainActor
final class OnboardingTests: XCTestCase {
    func testFirstLaunchOnboardingThenLogin() {
        let app = XCUIApplication()
        // `-onboardingSeen NO` stands in for a fresh install (the argument overrides whatever an earlier run stored).
        app.launchArguments = ["-onboardingSeen", "NO", "-onboarding", "", "-open", "", "-tab", "", "-sheet", "", "-draft", ""]
        app.launch()
        XCTAssertTrue(app.buttons["Skip"].waitForExistence(timeout: 10), "first launch shows onboarding")
        XCTAssertTrue(app.buttons["Continue"].exists)
        app.buttons["Skip"].tap()
        XCTAssertTrue(app.buttons["Log in"].waitForExistence(timeout: 5), "Skip leads to login")
        app.terminate()

        // Second launch: onboarding was seen, so login is the first screen.
        let again = XCUIApplication()
        again.launchArguments = ["-onboarding", "", "-open", "", "-tab", "", "-sheet", "", "-draft", ""]
        again.launch()
        XCTAssertTrue(again.buttons["Log in"].waitForExistence(timeout: 10))
        XCTAssertFalse(again.buttons["Skip"].exists, "onboarding is first launch only")
    }

    func testSignUpFormAndServerField() {
        let app = XCUIApplication()
        app.launchArguments = ["-onboarding", "NO", "-open", "", "-tab", "", "-sheet", "", "-draft", ""]
        app.launch()
        app.buttons["Create account"].tap()
        XCTAssertTrue(app.textFields["Name"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.textFields["Email"].exists)
        XCTAssertTrue(app.secureTextFields["Password"].exists)
        app.buttons["Server"].tap()
        XCTAssertTrue(app.textFields["Server address"].waitForExistence(timeout: 3))
    }
}
