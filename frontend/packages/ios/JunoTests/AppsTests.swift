import XCTest
@testable import Juno

// Apps (contracts 0.65.0): the pure logic of the Apps page, the values form and the chat connect card.

final class AppsTests: XCTestCase {
    private func app(_ id: String, category: String = "work", installations: String = "[]", enabled: String = "[]", extra: String = "", available: Bool = true) throws -> Contract.App {
        let json = """
        {"id":"\(id)","name":"\(id.capitalized)","category":"\(category)","icon":"x","blurb":"About \(id)","description":"","tryAsking":[],
         "auth":"oauth","available":\(available),"userConfig":[],"version":1,"grants":{"chatRead":true,"actions":true},
         "installations":\(installations),"enabledAgents":\(enabled)\(extra)}
        """
        return try isoDecoder.decode(Contract.App.self, from: Data(json.utf8))
    }

    private func account(_ id: String, status: String = "connected") -> String {
        #"{"id":"\#(id)","appId":"x","label":"\#(id)@x.com","status":"\#(status)","agents":[]}"#
    }

    // MARK: Pills and the "Sign in" state

    func testPillsFilterByCategoryAndConnected() throws {
        let slack = try app("slack", category: "chat", installations: "[\(account("T1"))]")
        let gmail = try app("gmail", installations: "[\(account("a"))]")
        let notion = try app("notion")
        let custom = try app("c1", category: "custom", installations: "[\(account("c1"))]")
        let youtube = try app("youtube", category: "web")
        let all = [slack, gmail, notion, custom, youtube]
        XCTAssertEqual(AppFilter.visible(all, filter: .connected, query: "").map(\.id), ["slack", "gmail", "c1"])
        XCTAssertEqual(AppFilter.visible(all, filter: .chat, query: "").map(\.id), ["slack"])
        XCTAssertEqual(AppFilter.visible(all, filter: .work, query: "").map(\.id), ["gmail", "notion", "c1"])
        XCTAssertEqual(AppFilter.visible(all, filter: .web, query: "").map(\.id), ["youtube"])
    }

    func testSearchLooksAcrossEveryCategory() throws {
        let all = [try app("slack", category: "chat"), try app("gmail"), try app("youtube", category: "web")]
        XCTAssertEqual(AppFilter.visible(all, filter: .connected, query: "you").map(\.id), ["youtube"])
        XCTAssertEqual(AppFilter.visible(all, filter: .chat, query: "about g").map(\.id), ["gmail"])
    }

    func testDefaultPillIsConnectedOnlyWhenSomethingIs() throws {
        XCTAssertEqual(AppFilter.initial(for: [try app("gmail")]), .chat)
        XCTAssertEqual(AppFilter.initial(for: [try app("gmail", installations: "[\(account("a"))]")]), .connected)
    }

    func testSignInShowsWhenAnyAccountExpired() throws {
        let fine = try app("gmail", installations: "[\(account("a")),\(account("b"))]")
        let expired = try app("notion", installations: "[\(account("a")),\(account("b", status: "expired"))]")
        XCTAssertFalse(fine.needsSignIn)
        XCTAssertTrue(expired.needsSignIn)
        XCTAssertEqual(expired.expiredAccount?.id, "b")
        XCTAssertEqual(expired.stateName, "Sign in needed")
        XCTAssertEqual(fine.stateName, "Connected")
    }

    func testWebAppsAreComingSoonOnlyWhenTheServerCannotAddThem() throws {
        let locked = try app("xiaohongshu", category: "web", available: false)
        XCTAssertTrue(locked.isComingSoon)
        XCTAssertFalse(locked.canAdd)
        XCTAssertEqual(locked.stateName, "Coming soon")
        let open = try app("youtube-videos", category: "web")
        XCTAssertFalse(open.isComingSoon)
        XCTAssertTrue(open.canAdd)
        XCTAssertTrue(open.isPerAgent)
    }

    func testFeaturedKeepsAppsWithPromptsInCatalogOrder() throws {
        func withPrompts(_ id: String, _ prompts: String) throws -> Contract.App {
            let json = #"{"id":"\#(id)","name":"\#(id)","category":"work","icon":"x","blurb":"","description":"","tryAsking":\#(prompts),"auth":"oauth","available":true,"userConfig":[],"version":1,"installations":[],"enabledAgents":[]}"#
            return try isoDecoder.decode(Contract.App.self, from: Data(json.utf8))
        }
        let none = try withPrompts("a", "[]")
        let first = try withPrompts("b", #"["Plan my week"]"#)
        let second = try withPrompts("c", #"["Find a file"]"#)
        XCTAssertEqual(AppFilter.featured([none, first, second]).map(\.id), ["b", "c"])
    }

    // MARK: userConfig form

    private func fields() throws -> [Contract.UserConfigField] {
        let json = """
        [{"key":"api_key","type":"string","title":"API key","description":"","required":true,"sensitive":true},
         {"key":"workspace","type":"string","title":"Workspace","description":"","required":false,"sensitive":false,"default":"main"},
         {"key":"limit","type":"number","title":"Limit","description":"","required":false,"sensitive":false},
         {"key":"region","type":"string","title":"Region","description":"","required":true,"sensitive":false,"options":["eu","us"]},
         {"key":"beta","type":"boolean","title":"Beta","description":"","required":false,"sensitive":false}]
        """
        return try isoDecoder.decode([Contract.UserConfigField].self, from: Data(json.utf8))
    }

    func testFormNeedsRequiredFieldsAndKnownOptions() throws {
        var form = UserConfigForm(fields: try fields())
        XCTAssertEqual(form.errors["api_key"], "Required")
        XCTAssertEqual(form.errors["region"], "Required")
        XCTAssertFalse(form.isValid)
        form.text["api_key"] = "  sk-1  "
        form.text["region"] = "asia"
        XCTAssertEqual(form.errors["region"], "Pick one of the options")
        form.text["region"] = "eu"
        form.text["limit"] = "ten"
        XCTAssertEqual(form.errors["limit"], "Enter a number")
        form.text["limit"] = "10"
        XCTAssertTrue(form.isValid)
    }

    func testFormSendsTypedValuesAndLeavesEmptyOptionalOut() throws {
        var form = UserConfigForm(fields: try fields())
        form.text["api_key"] = " sk-1 "
        form.text["region"] = "us"
        form.text["limit"] = "10"
        form.flags["beta"] = true
        XCTAssertEqual(form.values, ["api_key": .text("sk-1"), "workspace": .text("main"), "limit": .number(10), "region": .text("us"), "beta": .flag(true)])
        form.text["workspace"] = ""
        form.text["limit"] = ""
        XCTAssertNil(form.values["workspace"])
        XCTAssertNil(form.values["limit"])
        let body = try JSONEncoder().encode(InstallWorkBody(userConfig: form.values))
        XCTAssertTrue(String(decoding: body, as: UTF8.self).contains(#""beta":true"#))
    }

    // MARK: Connect card

    func testConnectCardOffersTheActionThatFixesEachProblem() throws {
        let missing = try app("gmail")
        let off = try app("notion", installations: "[\(account("a"))]", enabled: #"[{"agentId":"other"}]"#)
        let on = try app("slack", installations: "[\(account("a"))]", enabled: #"[{"agentId":"nova"}]"#)
        let expired = try app("asana", installations: "[\(account("old", status: "expired"))]", enabled: #"[{"agentId":"nova"}]"#)

        XCTAssertEqual(ConnectCard.problem(app: missing, agentId: "nova", payload: nil), .notAdded)
        XCTAssertEqual(ConnectCard.problem(app: off, agentId: "nova", payload: nil), .notEnabled)
        XCTAssertNil(ConnectCard.problem(app: on, agentId: "nova", payload: "not_enabled"))
        XCTAssertEqual(ConnectCard.problem(app: expired, agentId: "nova", payload: nil), .expired)
        // The list is not loaded yet: the request's own problem stands.
        XCTAssertEqual(ConnectCard.problem(app: nil, agentId: "nova", payload: "not_added"), .notAdded)

        XCTAssertEqual(ConnectCard.action(problem: .notAdded, app: missing), .add)
        XCTAssertEqual(ConnectCard.action(problem: .notEnabled, app: off), .turnOn)
        XCTAssertEqual(ConnectCard.action(problem: .expired, app: expired), .reconnect(connectionId: "old"))
        XCTAssertEqual(ConnectCard.action(problem: nil, app: on), .ready)
    }

    func testReconnectCoversASignInThatNeverWorkedOrLacksAPermission() throws {
        let never = try app("hevy", installations: "[\(account("k", status: "error"))]", enabled: #"[{"agentId":"nova"}]"#)
        // `error` = never worked: it needs reconnecting, not "expired".
        XCTAssertEqual(ConnectCard.problem(app: never, agentId: "nova", payload: nil), .needsReconnect)
        XCTAssertEqual(ConnectCard.action(problem: .needsReconnect, app: never), .reconnect(connectionId: "k"))
        XCTAssertEqual(ConnectCard.action(problem: .scopeMissing, app: never), .reconnect(connectionId: "k"))
        XCTAssertEqual(ConnectCard.note(for: .scopeMissing, agent: "Nova"), "Needs another permission")
        XCTAssertEqual(ConnectCard.note(for: .needsReconnect, agent: "Nova"), "Needs reconnecting")
    }

    func testAProblemFromANewerServerDecodesAndFallsBackToAdd() throws {
        // Enums decode an unknown raw value to `.unknown` instead of failing the whole response.
        let card = try isoDecoder.decode([Contract.AppProblem].self, from: Data(#"["expired","a_problem_from_a_newer_server"]"#.utf8))
        XCTAssertEqual(card, [.expired, .unknown])
        XCTAssertEqual(ConnectCard.action(problem: .unknown, app: nil), .add)
        // A whole response with a value this version does not know still decodes, and the raw string is kept on the wire struct.
        let installation = try isoDecoder.decode(Contract.AppInstallation.self, from: Data(#"{"id":"i","appId":"x","label":"x","status":"a_status_from_a_newer_server","agents":[]}"#.utf8))
        XCTAssertEqual(installation.status, "a_status_from_a_newer_server")
        let outcome = try isoDecoder.decode(Contract.OutcomeDetail.self, from: Data(#""stopped_by_a_future_actor""#.utf8))
        XCTAssertEqual(outcome, .unknown)
    }

    func testAnAppWithNewToolsShowsThemAsUnreviewed() throws {
        let detail = try isoDecoder.decode(Contract.AppDetail.self, from: Data("""
        {"id":"gmail","name":"Gmail","category":"work","icon":"x","blurb":"","description":"","tryAsking":[],"auth":"oauth","available":true,
         "userConfig":[],"version":1,"installations":[],"enabledAgents":[],"pending":[],"skills":[],
         "capabilities":[{"name":"send","title":"Send","kind":"change","needsReview":true},{"name":"read","title":"Read","kind":"read"}]}
        """.utf8))
        XCTAssertEqual(detail.capabilities?.filter { $0.needsReview == true }.map(\.name), ["send"])
    }

    // MARK: Layers (contracts 0.71.0)

    func testAMissingPermissionStaysOnTheCardUntilTheServerResolvesIt() throws {
        // The list shows the account as connected and on, so only the request's own problem can say a permission is missing.
        let signedIn = try app("gmail", installations: "[\(account("a"))]", enabled: #"[{"agentId":"nova"}]"#)
        XCTAssertEqual(ConnectCard.problem(app: signedIn, agentId: "nova", payload: "scope_missing"), .scopeMissing)
        XCTAssertEqual(ConnectCard.action(problem: .scopeMissing, app: signedIn), .reconnect(connectionId: "a"))
    }

    func testComposioAppsSayWhoHoldsTheLogin() throws {
        XCTAssertEqual(try app("spotify", extra: #","source":"composio""#).sourceNote, "Login held by Composio")
        XCTAssertNil(try app("gmail", extra: #","source":"official""#).sourceNote)
    }

    func testACustomServerIsConfirmedWithTheMarksThePersonLeft() throws {
        let probe = try isoDecoder.decode(Contract.ProbeCustomAppResponse.self, from: Data("""
        {"url":"https://mcp.example.com/mcp","auth":"none","usable":true,"tools":[
         {"name":"search","title":"Search","suggested":"read","basis":"annotation"},
         {"name":"sync","title":"Sync","suggested":"change","basis":"unmarked"}]}
        """.utf8))
        var review = CustomAppReview(probe: probe)
        XCTAssertFalse(review.isChange("search"))
        XCTAssertTrue(review.isChange("sync"))
        review.flip("search")
        review.flip("sync")
        XCTAssertEqual(review.confirm.auth, "none")
        XCTAssertEqual(review.confirm.tools, ["search": "change", "sync": "read"])
    }
}
