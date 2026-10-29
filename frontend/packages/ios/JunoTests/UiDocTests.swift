import XCTest
@testable import Juno

// Juno UI blocks (BACKEND 8.7.1): lenient block-by-block parsing, the text fallback, and the answer rules.

final class UiDocTests: XCTestCase {
    private func doc(_ json: String) throws -> UiDoc { try isoDecoder.decode(UiDoc.self, from: Data(json.utf8)) }

    private let compare = """
    {"version":1,"title":"Which Mac mini?","text":"Which Mac mini?\\n\\nOption A…","blocks":[
      {"type":"group","title":"Option A","blocks":[
        {"type":"facts","rows":[{"label":"Chip","value":"M4"},{"label":"Price","value":"S$899","emphasis":true}]},
        {"type":"notice","tone":"warning","text":"Ships in 2 weeks"}]},
      {"type":"items","rows":[{"name":"Mac mini","quantity":2,"price":"S$899"}],"total":{"label":"Total","value":"S$1,798"}},
      {"type":"table","columns":["Model","RAM"],"rows":[["M4","16 GB"],["M4 Pro"]]},
      {"type":"choices","id":"pick","options":[{"id":"a","label":"A","style":"primary"},{"id":"b","label":"B"}]}]}
    """

    func testEveryBlockTypeParses() throws {
        let d = try doc(compare)
        XCTAssertTrue(d.isRenderable)
        XCTAssertEqual(d.title, "Which Mac mini?")
        guard case .group(let title, let inner) = d.blocks[0] else { return XCTFail("group") }
        XCTAssertEqual(title, "Option A")
        guard case .facts(let facts) = inner[0] else { return XCTFail("facts") }
        XCTAssertEqual(facts.map(\.value), ["M4", "S$899"])
        XCTAssertTrue(facts[1].emphasis)
        guard case .items(let rows, let total) = d.blocks[1] else { return XCTFail("items") }
        XCTAssertEqual(rows[0].quantity, 2)
        XCTAssertEqual(total?.value, "S$1,798")
        // A short table row is padded, never fatal.
        guard case .table(_, let cells) = d.blocks[2] else { return XCTFail("table") }
        XCTAssertEqual(cells[1], ["M4 Pro", ""])
        guard case .choices(let choices) = try XCTUnwrap(d.interactive) else { return XCTFail("choices") }
        XCTAssertEqual(choices.options.map(\.style), ["primary", "default"])
    }

    func testUnknownBlockTypeFallsBackToTheServerText() throws {
        let d = try doc(#"{"version":1,"text":"Chart: sales up 4%","blocks":[{"type":"text","text":"hi"},{"type":"chart","points":[1,2]}]}"#)
        XCTAssertFalse(d.isRenderable)
        XCTAssertEqual(d.text, "Chart: sales up 4%")
        // The same for a block of a known type with a shape this app cannot read, and for an unknown version.
        XCTAssertFalse(try doc(#"{"version":1,"text":"t","blocks":[{"type":"facts","rows":"nope"}]}"#).isRenderable)
        XCTAssertFalse(try doc(#"{"version":2,"text":"t","blocks":[{"type":"text","text":"hi"}]}"#).isRenderable)
    }

    func testAnUndecodableDocNeverFailsTheItem() throws {
        let items = try isoDecoder.decode([Item].self, from: Data(#"""
        [{"id":"i1","type":"agent_message","markdown":"Here you go","ui":{"version":1,"text":"T","blocks":[{"type":"text","text":"hi"},{"type":"hologram","depth":3}]}},
         {"id":"i2","type":"agent_message","markdown":"fallback","ui":"not even an object"}]
        """#.utf8))
        XCTAssertEqual(items.count, 2)
        XCTAssertEqual(items[0].ui?.isRenderable, false)
        XCTAssertEqual(items[0].ui?.text, "T")
        XCTAssertEqual(items[1].ui?.isRenderable, false)
    }

    func testQuestionAndApprovalPayloadsCarryTheDoc() throws {
        let q = try isoDecoder.decode(AgentRequest.self, from: Data(#"""
        {"id":"r1","kind":"question","status":"answered","payload":{"kind":"question","answers":{"pick":"b"},
         "ui":{"version":1,"title":"Pick","blocks":[{"type":"choices","id":"pick","options":[{"id":"a","label":"A"},{"id":"b","label":"B"}]}]}}}
        """#.utf8))
        let ui = try XCTUnwrap(q.payload?.ui)
        XCTAssertEqual(ui.headline, "Pick")
        XCTAssertEqual(UiAnswers.summary(ui, q.payload?.answers), "B")
        let approval = try isoDecoder.decode(AgentRequest.self, from: Data(#"""
        {"id":"r2","kind":"approval","status":"pending","payload":{"kind":"approval","action":"Purchase","target":"x","app":"Apple","why":"w",
         "ui":{"version":1,"blocks":[{"type":"items","rows":[{"name":"Mac mini"}]},{"type":"image","libraryId":"lib_1"}]}}}
        """#.utf8))
        XCTAssertEqual(approval.payload?.ui?.isRenderable, true)
    }

    func testChoiceAnswersEncodeLikeTheContract() {
        XCTAssertEqual(UiAnswers.encodeChoice(["a", "c"]), #"["a","c"]"#)
        XCTAssertEqual(UiAnswers.decodeChoice(#"["a","c"]"#, multiple: true), ["a", "c"])
        XCTAssertEqual(UiAnswers.decodeChoice("a", multiple: false), ["a"])
    }

    func testFieldValidationMirrorsTheContract() {
        func field(_ kind: String, required: Bool = true, options: [String] = []) -> UiField {
            UiField(id: "f", label: "F", kind: kind, options: options, required: required, placeholder: nil)
        }
        XCTAssertEqual(UiAnswers.problem(field("text"), "  "), "Required")
        XCTAssertNil(UiAnswers.problem(field("text", required: false), ""))
        XCTAssertNil(UiAnswers.problem(field("number"), "-12.5"))
        XCTAssertNotNil(UiAnswers.problem(field("number"), "1,5"))
        XCTAssertNil(UiAnswers.problem(field("date"), "2026-02-28"))
        XCTAssertNotNil(UiAnswers.problem(field("date"), "2026-02-30"))
        XCTAssertNotNil(UiAnswers.problem(field("date"), "02/03/2026"))
        XCTAssertNil(UiAnswers.problem(field("select", options: ["S", "M"]), "M"))
        XCTAssertNotNil(UiAnswers.problem(field("select", options: ["S", "M"]), "XL"))
        XCTAssertNotNil(UiAnswers.problem(field("text"), String(repeating: "x", count: 1001)))
    }

    func testFeedRefItemDecodes() throws {
        let item = try isoDecoder.decode(Item.self, from: Data(#"{"id":"i9","type":"feed_ref","conversationId":"c1","agentId":"a1","feedPostId":"fp1","title":"Mac mini prices fell","imageUrl":"https://example.com/a.png","at":"2026-10-15T08:00:00Z"}"#.utf8))
        XCTAssertEqual(item.feedPostId, "fp1")
        XCTAssertEqual(item.title, "Mac mini prices fell")
        XCTAssertEqual(item.imageUrl, "https://example.com/a.png")
    }
}
