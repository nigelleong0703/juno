import XCTest

/// Live (opt-in): a fresh account with no model provider. Walks Settings → Models: the setup notice, the empty state,
/// adding a custom endpoint (private URL rejected), the ChatGPT paste step and OpenCode Go with a DUMMY key, then the
/// default-model picker. SHOT lines. Needs TEST_RUNNER_JUNO_SERVER / _EMAIL / _PASSWORD; never use a real key here.
@MainActor
final class ModelSettingsTests: XCTestCase {
    private func shot(_ name: String) {
        Thread.sleep(forTimeInterval: 0.8)
        let url = URL(fileURLWithPath: NSTemporaryDirectory()).appending(path: "\(name).png")
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: url)
        print("SHOT|\(name)|\(url.path)")
    }

    /// The iOS 26 search bar sits at the bottom of the sheet and may surface as a search field or a text field.
    private func searchField(_ app: XCUIApplication) -> XCUIElement {
        app.searchFields.firstMatch.exists ? app.searchFields.firstMatch : app.textFields["Search providers"]
    }

    func testModelProviders() throws {
        let env = ProcessInfo.processInfo.environment
        guard let server = env["JUNO_SERVER"], let email = env["JUNO_EMAIL"], let password = env["JUNO_PASSWORD"] else {
            throw XCTSkip("JUNO_SERVER / JUNO_EMAIL / JUNO_PASSWORD not set")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-onboarding", "NO", "-server", server, "-email", email, "-open", "", "-tab", "", "-sheet", "", "-draft", ""]
        app.launch()

        if app.buttons["Log in"].waitForExistence(timeout: 6) {
            app.buttons["Log in"].tap()
            XCTAssertTrue(app.textFields["Email"].waitForExistence(timeout: 5))
            app.secureTextFields["Password"].tap(); app.secureTextFields["Password"].typeText(password + "\n")
            let notNow = app.buttons["Not Now"]
            if notNow.waitForExistence(timeout: 6) { notNow.tap() }
        }
        Thread.sleep(forTimeInterval: 4); shot("byok-0-after-login")
        let chatTab = app.tabBars.buttons["Chat"]
        XCTAssertTrue(chatTab.waitForExistence(timeout: 20))
        chatTab.tap()
        let chat = app.staticTexts["Iris"].firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 15), "the account's agent chat is not listed")
        chat.tap()

        // 1. Chat with the "add a provider" notice above the composer.
        let notice = app.otherElements["model-provider-notice"]
        XCTAssertTrue(notice.waitForExistence(timeout: 15), "usable=false notice missing")
        shot("byok-1-chat-notice")

        // 2. Notice → Models (empty state).
        app.buttons["open-model-settings"].firstMatch.tap()
        XCTAssertTrue(app.buttons["models-empty-add"].waitForExistence(timeout: 10))
        shot("byok-2-models-empty")

        // 3. Add provider sheet.
        app.buttons["models-empty-add"].tap()
        XCTAssertTrue(app.buttons["add-custom"].waitForExistence(timeout: 10))
        shot("byok-3-add-provider")

        // 4. Custom endpoint with a private URL: the server refuses, the form stays with an inline error.
        app.buttons["add-custom"].tap()
        let name = app.textFields["custom-name"]; XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.tap(); name.typeText("Home gateway")
        let url = app.textFields["custom-url"]; url.tap(); url.typeText("http://10.0.0.5/v1")
        let key = app.secureTextFields["provider-key-field"]; key.tap(); key.typeText("sk-dummy-ios-test")
        app.buttons["provider-save"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'private or local network'")).firstMatch.waitForExistence(timeout: 15))
        Thread.sleep(forTimeInterval: 1.5)
        shot("byok-4-custom-private-url")
        app.navigationBars["Custom endpoint"].buttons.firstMatch.tap()

        // 5. OpenAI: key form with the ChatGPT option, then the paste step.
        let search = searchField(app)
        XCTAssertTrue(search.waitForExistence(timeout: 5)); search.tap(); search.typeText("openai")
        XCTAssertTrue(app.buttons["add-openai"].waitForExistence(timeout: 5)); app.buttons["add-openai"].tap()
        XCTAssertTrue(app.buttons["use-chatgpt"].waitForExistence(timeout: 5))
        shot("byok-5-openai-detail")
        app.buttons["use-chatgpt"].tap()
        XCTAssertTrue(app.buttons["chatgpt-open"].waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 1)
        shot("byok-6-chatgpt-paste")
        // A wrong address: the login is spent, a fresh one starts, and the form says so.
        let address = app.textFields["chatgpt-address"]; address.tap(); address.typeText("http://127.0.0.1:1455/nope")
        app.buttons["chatgpt-connect"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'We made a new sign-in link'")).firstMatch.waitForExistence(timeout: 15))
        shot("byok-7-chatgpt-restarted")
        app.navigationBars["Sign in with ChatGPT"].buttons.firstMatch.tap()
        app.navigationBars["Connect OpenAI"].buttons.firstMatch.tap()

        // 6. OpenCode Go with a dummy key → provider list.
        let again = searchField(app)
        XCTAssertTrue(again.waitForExistence(timeout: 5)); again.clearAndType("opencode")
        XCTAssertTrue(app.buttons["add-opencode-go"].waitForExistence(timeout: 5)); app.buttons["add-opencode-go"].tap()
        let k2 = app.secureTextFields["provider-key-field"]; XCTAssertTrue(k2.waitForExistence(timeout: 5))
        k2.tap(); k2.typeText("sk-dummy-ios-test")
        app.buttons["provider-save"].tap()
        XCTAssertTrue(app.staticTexts["Your providers"].waitForExistence(timeout: 15))
        shot("byok-8-provider-list")

        // 7. Default model: the only keyed provider is preselected; model list is a pushed searchable page.
        let model = app.buttons["default-model"]
        if !model.waitForExistence(timeout: 10) { app.swipeUp() }
        XCTAssertTrue(model.waitForExistence(timeout: 10))
        shot("byok-9-default-model")
        model.tap()
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 5))
        shot("byok-10-model-picker")
    }
}

private extension XCUIElement {
    /// Puts the caret at the end, deletes whatever is there (a remembered email, a search term), then types.
    func clearAndType(_ text: String) {
        coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
        typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 60))
        typeText(text)
    }
}
