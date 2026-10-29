import SwiftUI
import WebKit

/// Runs formatting commands in the editor page. The native bar holds one; the web view registers itself on creation.
@MainActor
final class EditorController {
    fileprivate weak var web: WKWebView?
    func run(_ command: EditorCommand, argument: String? = nil) { web?.evaluateJavaScript(EditorScript.command(command, argument: argument)) }
}

/// The document editor: the SAME page the web app uses (packages/doc-editor), built into the app bundle under `DocEditor/`
/// by the pre-build script and shown in a web view with no network. The page owns the text; the app sends it Markdown and
/// formatting commands and gets `ready`, `mode`, `change` and `state` back (`EditorEvent`).
struct DocumentEditorWebView: UIViewRepresentable {
    var markdown: String
    /// Changes whenever `markdown` is a new baseline to load (typing never changes either).
    var resetKey: Int
    var editable: Bool
    var controller: EditorController
    var onEvent: (EditorEvent) -> Void

    /// The bundled page, or nil when the build step did not run.
    static var pageURL: URL? { Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "DocEditor") }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.userContentController.add(WeakScriptHandler(context.coordinator), name: "junoEditor")
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        web.scrollView.keyboardDismissMode = .interactive
        web.allowsLinkPreview = false
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        controller.web = web
        if let url = Self.pageURL { web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent()) }
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.push(to: web)
    }

    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var parent: DocumentEditorWebView
        private var ready = false
        private var sentKey: Int?
        private var sentEditable: Bool?

        init(_ parent: DocumentEditorWebView) { self.parent = parent }

        func handle(_ body: Any) {
            guard let event = EditorEvent.parse(body) else { return }
            if event == .ready { ready = true; if let web = parent.controller.web { push(to: web) } }
            parent.onEvent(event)
        }

        /// Send what the page has not seen yet: a new baseline, and the editable flag.
        func push(to web: WKWebView) {
            guard ready else { return }
            if sentKey != parent.resetKey {
                sentKey = parent.resetKey
                web.evaluateJavaScript(EditorScript.setMarkdown(parent.markdown))
            }
            if sentEditable != parent.editable {
                sentEditable = parent.editable
                web.evaluateJavaScript(EditorScript.setEditable(parent.editable))
            }
        }

        // Only the bundled page may load: no navigation away from it, no new windows.
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            navigationAction.request.url?.isFileURL == true ? .allow : .cancel
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
    }
}

/// `WKUserContentController` keeps its handlers alive: a weak hop keeps the coordinator from being retained by the web view.
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    private weak var target: DocumentEditorWebView.Coordinator?
    init(_ target: DocumentEditorWebView.Coordinator) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let body = message.body
        Task { @MainActor in target?.handle(body) }
    }
}
