import WebKit
import XCTest
@testable import Juno

// Documents (contracts 0.70, BACKEND §5.11a): the editor page's bridge, the review diff and the wire shapes.

final class DocumentBridgeTests: XCTestCase {
    func testPageEventsParseAndUnknownOnesAreIgnored() {
        XCTAssertEqual(EditorEvent.parse(["type": "ready"]), .ready)
        XCTAssertEqual(EditorEvent.parse(["type": "mode", "mode": "source"]), .mode("source"))
        XCTAssertEqual(EditorEvent.parse(["type": "change", "markdown": "# Hi"]), .change("# Hi"))
        XCTAssertEqual(EditorEvent.parse(["type": "state", "state": ["bold": true, "undo": false]]), .state(["bold": true, "undo": false]))
        XCTAssertNil(EditorEvent.parse(["type": "change"]))
        XCTAssertNil(EditorEvent.parse(["type": "bogus"]))
        XCTAssertNil(EditorEvent.parse("text"))
    }

    func testScriptsCarryTheTextAsJSONSoQuotesAndNewlinesCannotBreakOut() throws {
        let nasty = "He said \"hi\"\n</script><script>alert(1)</script> \u{2028} \\ end"
        let script = EditorScript.setMarkdown(nasty)
        XCTAssertTrue(script.hasPrefix("junoEditor.receive(") && script.hasSuffix(")"))
        let json = String(script.dropFirst("junoEditor.receive(".count).dropLast())
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(object["type"] as? String, "setMarkdown")
        XCTAssertEqual(object["markdown"] as? String, nasty)
        XCTAssertTrue(EditorScript.command(.link, argument: "https://example.com").contains("\"argument\""))
        XCTAssertFalse(EditorScript.command(.bold).contains("argument"))
    }
}

final class DocumentDiffTests: XCTestCase {
    func testBlocksKeepFencedCodeWhole() {
        XCTAssertEqual(BlockDiff.blocks("# A\n\ntext\nmore\n\n```\ncode\n\nmore\n```"), ["# A", "text\nmore", "```\ncode\n\nmore\n```"])
    }

    func testDiffMarksWhatTheDraftAddsAndRemoves() {
        let diff = BlockDiff.diff(saved: "# Plan\n\nKeep this.\n\nOld paragraph.", draft: "# Plan\n\nKeep this.\n\nNew paragraph.")
        XCTAssertEqual(diff, [
            DiffBlock(kind: .same, text: "# Plan"), DiffBlock(kind: .same, text: "Keep this."),
            DiffBlock(kind: .added, text: "New paragraph."), DiffBlock(kind: .removed, text: "Old paragraph."),
        ])
    }
}

final class DocumentWireTests: XCTestCase {
    func testDocumentViewReadsTheDraftAuthorAndTheExternalTarget() throws {
        let json = """
        {"document":{"id":"doc-1","name":"Trip plan","kind":"document","render":"doc","mimeType":"text/markdown","version":2,
                     "target":{"appId":"google-docs","externalId":"x","url":"https://docs.google.com/document/d/x"}},
         "draft":{"id":"d1","documentId":"doc-1","baseVersion":2,"revision":3,"title":"Trip plan","summary":"Reworded","author":{"agentId":"agent-a"},"status":"pending"}}
        """
        let view = try isoDecoder.decode(DocView.self, from: Data(json.utf8))
        XCTAssertEqual(view.headVersion, 2)
        XCTAssertEqual(view.openDraft?.author?.agentId, "agent-a")
        XCTAssertEqual(view.openDraft?.revision, 3)
        XCTAssertEqual(view.target?.appId, "google-docs")
    }

    func testAPersonDraftAndADecidedDraft() throws {
        let person = try isoDecoder.decode(DocDraft.self, from: Data(#"{"id":"d","revision":1,"author":"person","status":"pending"}"#.utf8))
        XCTAssertNil(person.author?.agentId)
        XCTAssertTrue(person.isOpen)
        let declined = try isoDecoder.decode(DocDraft.self, from: Data(#"{"id":"d","revision":1,"author":"person","status":"declined"}"#.utf8))
        XCTAssertFalse(declined.isOpen)
    }
}

/// The page the app bundles, run in a real web view: it must start without network, open Markdown it can round-trip in the
/// rich editor, open anything else as plain Markdown, and report edits through the bridge.
@MainActor
final class DocumentEditorPageTests: XCTestCase {
    private final class Inbox: NSObject, WKScriptMessageHandler {
        var events: [EditorEvent] = []
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            if let event = EditorEvent.parse(message.body) { events.append(event) }
        }
    }

    private func wait(_ what: String, _ condition: () -> Bool) async throws {
        for _ in 0..<200 where !condition() { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertTrue(condition(), "timed out waiting for \(what)")
    }

    func testBundledPageOpensRichOrSourceAndReportsEdits() async throws {
        let url = try XCTUnwrap(DocumentEditorWebView.pageURL, "DocEditor/index.html is not in the app bundle (the pre-build script did not run)")
        let inbox = Inbox()
        let config = WKWebViewConfiguration()
        config.userContentController.add(inbox, name: "junoEditor")
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 800), configuration: config)
        web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        try await wait("ready") { inbox.events.contains(.ready) }

        _ = try await web.evaluateJavaScript(EditorScript.setMarkdown("# Title\n\nHello **world**."))
        try await wait("rich mode") { inbox.events.contains(.mode("rich")) }
        let heading = try await web.evaluateJavaScript("document.querySelector('.doc-editor-content h1')?.textContent")
        XCTAssertEqual(heading as? String, "Title")

        let html = "Intro\n\n<div class=\"x\">raw html</div>\n"
        _ = try await web.evaluateJavaScript(EditorScript.setMarkdown(html))
        try await wait("source mode") { inbox.events.contains(.mode("source")) }
        let field = try await web.evaluateJavaScript("document.querySelector('textarea')?.value")
        XCTAssertEqual(field as? String, html)

        _ = try await web.evaluateJavaScript("""
        (() => { const t = document.querySelector('textarea');
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, 'Edited <b>raw</b>');
          t.dispatchEvent(new Event('input', { bubbles: true })); })()
        """)
        try await wait("change") { inbox.events.contains(.change("Edited <b>raw</b>")) }
    }
}
