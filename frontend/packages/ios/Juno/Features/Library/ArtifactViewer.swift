import AVKit
import PDFKit
import QuickLook
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import WebKit

// MARK: - The one full-screen viewer for every artifact type (web: components/artifact/ArtifactViewer.tsx)
// Opened from the Library grid, a chat card and the Files list. A top bar (close, title, version menu, Share, Download)
// and the content. Until the content is on screen the item's picture sits underneath with a spinner.

/// What the viewer shows for an item.
enum ViewerKind {
    case space, page, image, video, document

    static func of(_ file: LibraryItem) -> ViewerKind {
        if file.isSpace { return .space }
        if file.render == "html" { return .page }
        if file.isImage { return .image }
        if file.isVideo { return .video }
        return .document
    }
}

/// A document opens in `DocumentViewer` (the editor is its content); every other item in the file viewer.
struct ArtifactViewer: View {
    var file: LibraryItem

    var body: some View {
        if file.render == "doc" { DocumentViewer(file: file) } else { FileViewer(file: file) }
    }
}

private struct FileViewer: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var file: LibraryItem
    @State private var picked: Int?
    @State private var ready = false
    @State private var status: String?
    @State private var hosted: Contract.SpaceHosted?
    @State private var sharingSpace = false
    @State private var shareItem: ShareFile?
    @State private var exporting = false
    @State private var exportDocument = FileExport(data: Data())
    @State private var busy = false
    @State private var failed: String?

    private var versions: [Contract.ArtifactVersion] { file.versions ?? [] }
    private var latest: Int { file.latestVersionNumber ?? 1 }
    private var shown: Int { picked.flatMap { p in versions.contains { $0.version == p } ? p : nil } ?? latest }
    private var current: Contract.ArtifactVersion? { versions.first { $0.version == shown } ?? versions.last }
    private var kind: ViewerKind { .of(file) }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ZStack {
                    content
                    if !ready { cover }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipped()
                if let failed { Text(failed).text(.xs).foregroundStyle(Theme.danger).padding(8) }
            }
            .background(Theme.canvas)
            .pageHeader(file.name ?? "")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close", systemImage: "xmark") { dismiss() }.accessibilityIdentifier("Close")
                }
                ToolbarItemGroup(placement: .topBarTrailing) { actions }
            }
            .onChange(of: shown) { ready = false }
            .task(id: file.spaceId) { await pollSpace() }
            .sheet(item: $shareItem) { ActivityView(url: $0.url) }
            .fileExporter(isPresented: $exporting, document: exportDocument, contentType: .data, defaultFilename: file.name ?? "download") { _ in }
            .sheet(isPresented: $sharingSpace) {
                if let spaceId = file.spaceId { SpaceShareSheet(spaceId: spaceId, name: file.name ?? "", hosted: $hosted) }
            }
        }
    }

    // MARK: Top bar actions (a Space shares as a link; a file shares and saves)

    @ViewBuilder private var actions: some View {
        if versions.count > 1 { versionMenu }
        if kind == .space {
            Button("Share", systemImage: "square.and.arrow.up") { sharingSpace = true }
                .disabled(file.spaceId == nil)
        } else {
            Button("Share", systemImage: "square.and.arrow.up") { Task { await share() } }.disabled(busy)
            Button("Download", systemImage: "arrow.down.circle") { Task { await download() } }.disabled(busy)
        }
    }

    private var versionMenu: some View {
        Menu {
            ForEach(versions.reversed(), id: \.version) { v in
                Button("v\(v.version ?? 0)\(v.version == latest ? " (latest)" : "")") { picked = v.version }
            }
        } label: {
            Text("v\(shown)")
        }
        .accessibilityLabel("Choose version")
    }

    // MARK: Content

    @ViewBuilder private var content: some View {
        switch kind {
        case .space: SpaceBody(file: file, status: status, onReady: { ready = true })
        case .page: PageBody(artifactId: file.id, version: shown, onReady: { ready = true })
        case .image: ImageBody(file: file, version: shown, onReady: { ready = true })
        case .video: VideoBody(file: file, version: shown, onReady: { ready = true })
        case .document: DocumentBody(file: file, version: shown, current: current, onReady: { ready = true })
        }
    }

    /// The picture under a spinner while the content loads: never a blank area.
    private var cover: some View {
        ZStack {
            ArtifactThumbnail(file: file, symbol: .xl)
            ProgressView()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityLabel("Loading")
    }

    // MARK: Actions

    /// A Space's status and copy of its hosted link, re-checked every 20 s while the viewer is open.
    private func pollSpace() async {
        guard let id = file.spaceId else { return }
        status = world.spaces.first { $0.id == id }?.status
        hosted = world.spaces.first { $0.id == id }?.hosted
        while !Task.isCancelled {
            if let space = try? await world.space(id) { status = space.status; hosted = space.hosted }
            try? await Task.sleep(for: .seconds(20))
        }
    }

    private func share() async {
        guard !busy else { return }
        busy = true; failed = nil
        defer { busy = false }
        do {
            let data = try await world.itemBytes(file, version: shown)
            shareItem = ShareFile(url: try writeTemp(data, name: file.name ?? "download"))
        } catch { failed = "Download failed. Try again." }
    }

    private func download() async {
        guard !busy else { return }
        busy = true; failed = nil
        defer { busy = false }
        do {
            exportDocument = FileExport(data: try await world.itemBytes(file, version: shown))
            exporting = true
        } catch { failed = "Download failed. Try again." }
    }
}

// MARK: - Bodies (each fills its frame and calls `onReady` once its content is on screen)

/// An interactive page: the locked-down web view, full size. Its address is requested fresh when it is about to expire.
private struct PageBody: View {
    @Environment(World.self) private var world
    var artifactId: String
    var version: Int
    var onReady: () -> Void
    @State private var render: (url: URL, expiresAt: Date)?
    @State private var failed = false

    var body: some View {
        Group {
            if let render {
                SandboxedWebView(url: render.url, onLoaded: onReady)
            } else if failed {
                VStack(spacing: 8) {
                    Text("Couldn't load this page.").text(.sm).foregroundStyle(Theme.fgMuted)
                    Button("Retry") { Task { await load(force: true) } }.buttonStyle(WebButton(variant: .secondary, size: .sm))
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Color.clear
            }
        }
        .task(id: version) { await load(force: false) }
    }

    /// Ask for a URL when there is none, or the one held is about to expire.
    private func load(force: Bool) async {
        if !force, let r = render, r.expiresAt.timeIntervalSinceNow > 60 { return }
        failed = false
        do { render = try await world.artifactRenderURL(artifactId, version: version) } catch { failed = true; onReady() }
    }
}

/// A picture, zoomable: fit to the screen, pinch to zoom up to 4x, double-tap to toggle 2x.
private struct ImageBody: View {
    @Environment(World.self) private var world
    var file: LibraryItem
    var version: Int
    var onReady: () -> Void
    @State private var image: UIImage?
    @State private var failed = false
    @State private var scale: CGFloat = 1
    @State private var baseScale: CGFloat = 1

    var body: some View {
        Group {
            if let image {
                GeometryReader { geo in
                    ScrollView([.horizontal, .vertical]) {
                        Image(uiImage: image).resizable().scaledToFit()
                            .frame(width: geo.size.width * scale, height: geo.size.height * scale)
                    }
                }
                .gesture(MagnifyGesture()
                    .onChanged { scale = min(4, max(1, baseScale * $0.magnification)) }
                    .onEnded { _ in baseScale = scale })
                .onTapGesture(count: 2) {
                    scale = scale > 1 ? 1 : 2
                    baseScale = scale
                }
            } else if failed {
                Text("Image unavailable.").text(.sm).foregroundStyle(Theme.fgSubtle)
            } else {
                Color.clear
            }
        }
        .task(id: version) {
            guard let data = try? await world.itemBytes(file, version: version), let img = UIImage(data: data) else {
                failed = true; onReady(); return
            }
            image = img
            onReady()
        }
    }
}

/// A video, with its own controls.
private struct VideoBody: View {
    @Environment(World.self) private var world
    var file: LibraryItem
    var version: Int
    var onReady: () -> Void
    @State private var player: AVPlayer?
    @State private var failed = false

    var body: some View {
        Group {
            if let player {
                VideoPlayer(player: player)
            } else if failed {
                Text("Video unavailable.").text(.sm).foregroundStyle(Theme.fgSubtle)
            } else {
                Color.clear
            }
        }
        .task(id: version) {
            guard let data = try? await world.itemBytes(file, version: version), let url = try? writeTemp(data, name: file.name ?? "video") else {
                failed = true; onReady(); return
            }
            player = AVPlayer(url: url)
            onReady()
        }
        .onDisappear { player?.pause() }
    }
}

/// A document: Markdown and plain text as text, a PDF or an Office file's preview as pages, anything else as its facts.
private struct DocumentBody: View {
    @Environment(World.self) private var world
    var file: LibraryItem
    var version: Int
    var current: Contract.ArtifactVersion?
    var onReady: () -> Void
    @State private var text: String?
    @State private var pdf: PDFDocument?
    /// A plain file (no render type) that QuickLook can show, saved to a temp file for it.
    @State private var quickLookURL: URL?
    @State private var loaded = false

    private var mime: String { current?.mimeType ?? file.mimeType ?? "" }
    private var isMarkdown: Bool { mime == "text/markdown" || (file.name ?? "").lowercased().hasSuffix(".md") }
    private var isPlainText: Bool { mime.hasPrefix("text/") || mime == "application/json" }
    /// A PDF shows itself; an Office file shows the preview the computer made of it.
    private var previewPart: String? { mime == "application/pdf" ? "file" : current?.previewRef != nil ? "preview" : nil }

    var body: some View {
        Group {
            if let text {
                ScrollView {
                    if isMarkdown {
                        AgentMarkdown(text: text).foregroundStyle(Theme.fg)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(16)
                    } else {
                        Text(text).text(.sm).foregroundStyle(Theme.fgMuted)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(16)
                    }
                }
            } else if let pdf {
                PDFPreview(document: pdf)
            } else if let quickLookURL {
                QuickLookPreview(url: quickLookURL)
            } else if loaded {
                FileFacts(file: file)
            } else {
                Color.clear
            }
        }
        .task(id: version) { await load() }
    }

    private func load() async {
        defer { loaded = true; onReady() }
        if file.render == nil {
            // A plain file: QuickLook shows what it can (CSV, Office, PDF, text). The facts only when it cannot.
            guard let data = try? await world.itemBytes(file, version: nil),
                  let url = try? writeTemp(data, name: file.name ?? "file"),
                  QLPreviewController.canPreview(url as NSURL) else { return }
            quickLookURL = url
            return
        }
        if isMarkdown || isPlainText {
            // A file must not pull in remote pictures when shown: drop image syntax.
            guard let data = try? await world.itemBytes(file, version: version), let raw = String(data: data, encoding: .utf8) else { return }
            text = isMarkdown ? raw.replacingOccurrences(of: #"!\[[^\]]*\]\([^)]*\)"#, with: "", options: .regularExpression) : raw
        } else if let part = previewPart, let data = try? await world.itemBytes(file, version: version, part: part) {
            pdf = PDFDocument(data: data)
        }
    }
}

/// A plain file: its picture (or symbol) and the facts about it. Download and Share are in the top bar.
private struct FileFacts: View {
    @Environment(World.self) private var world
    var file: LibraryItem

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                ArtifactThumbnail(file: file, symbol: .xxl)
                    .frame(maxWidth: .infinity).frame(height: 200)
                    .clipShape(.rect(cornerRadius: Radius.lg))
                VStack(alignment: .leading, spacing: 10) {
                    fact("Kind", fileTypeLine(file))
                    fact("Created by", world.agent(file.createdByAgentId)?.name ?? (file.source == "upload" ? "You" : "An agent"))
                    fact("Created", Fmt.ago(file.createdAt))
                    fact("Shared", file.shared == "team" ? "Team" : "Private")
                }
            }
            .padding(16)
        }
    }

    private func fact(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label).text(.sm).foregroundStyle(Theme.fgMuted)
            Spacer(minLength: 0)
            Text(value).text(.sm).foregroundStyle(Theme.fg).lineLimit(1)
        }
    }
}

/// A running app: its status and the Open button. The app itself is never embedded.
private struct SpaceBody: View {
    var file: LibraryItem
    var status: String?
    var onReady: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "macwindow").text(.xxl).foregroundStyle(Theme.fgMuted)
                .frame(width: 72, height: 72).background(Theme.bgSubtle, in: .rect(cornerRadius: Radius.xl))
            Text(file.name ?? "").text(.lg, .semibold).foregroundStyle(Theme.fg).multilineTextAlignment(.center)
            if let word = spaceStatusWord(status) { Text(word).text(.sm).foregroundStyle(Theme.fgMuted) }
            SpaceOpenButton(spaceId: file.spaceId, paused: status == "computer_paused")
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear(perform: onReady)
    }
}

// MARK: - Web views and PDFs

/// The page is untrusted: no persistent storage, no navigation away from the render URL, no new windows, no file access.
private struct SandboxedWebView: UIViewRepresentable {
    var url: URL
    var onLoaded: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(url, onLoaded: onLoaded) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.preferences.setValue(false, forKey: "allowFileAccessFromFileURLs")
        config.setValue(false, forKey: "allowUniversalAccessFromFileURLs")
        let web = WKWebView(frame: .zero, configuration: config)
        web.allowsLinkPreview = false
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.isOpaque = false
        web.backgroundColor = .white
        web.load(URLRequest(url: url))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        guard context.coordinator.allowed != url else { return }
        context.coordinator.allowed = url
        web.load(URLRequest(url: url))
    }

    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var allowed: URL
        let onLoaded: () -> Void
        init(_ url: URL, onLoaded: @escaping () -> Void) { allowed = url; self.onLoaded = onLoaded }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            navigationAction.request.url == allowed ? .allow : .cancel
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { onLoaded() }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { onLoaded() }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
    }
}

private struct PDFPreview: UIViewRepresentable {
    var document: PDFDocument
    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.document = document
        return view
    }
    func updateUIView(_ view: PDFView, context: Context) {}
}

/// QuickLook for a plain file, embedded in the viewer's content area (the viewer keeps its own top bar).
private struct QuickLookPreview: UIViewControllerRepresentable {
    var url: URL

    func makeCoordinator() -> Coordinator { Coordinator(url) }

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: QLPreviewController, context: Context) {}

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(_ url: URL) { self.url = url }
        nonisolated func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        nonisolated func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
            url as NSURL
        }
    }
}

// MARK: - Saving and sharing

struct ShareFile: Identifiable { let id = UUID(); var url: URL }

/// Writes bytes under a fresh temp folder with a safe file name (no directories from the artifact's name).
private func writeTemp(_ data: Data, name: String) throws -> URL {
    let base = name.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? "download"
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let url = dir.appendingPathComponent(base.isEmpty ? "download" : base)
    try data.write(to: url)
    return url
}

private struct ActivityView: UIViewControllerRepresentable {
    var url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: [url], applicationActivities: nil) }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// Hands the bytes to the system's save panel (Files), which names them after the item.
struct FileExport: FileDocument {
    static var readableContentTypes: [UTType] { [.data] }
    var data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}
