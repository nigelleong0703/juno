import SwiftUI

// MARK: - The viewer of a document (web: components/document/DocumentViewer.tsx)
// The same frame as `ArtifactViewer` (close, title, actions, content), with the editor page as its content. An agent's draft
// opens for review: Approve & save, Decline in the menu, and Draft | Changes (a block diff against the saved version). The
// owner's own edits autosave as a draft and Save makes them the next version. "Talk about this document" pushes the chat.

struct DocumentViewer: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var file: LibraryItem
    @State private var session: DocumentSession?
    @State private var controller = EditorController()
    @State private var mode = "rich"
    @State private var format: [String: Bool] = [:]
    @State private var segment = Segment.draft
    @State private var chat: String?
    @State private var linkAsk = false
    @State private var linkURL = ""
    @State private var openingChat = false

    private enum Segment: String, CaseIterable { case draft = "Draft", changes = "Changes" }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let session { content(session) } else { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
            }
            .background(Theme.canvas)
            .pageHeader(session?.view?.document.name ?? file.name ?? "")
            .toolbar { toolbar }
            .navigationDestination(item: $chat) { ConversationView(conversationId: $0).id($0) }
        }
        .task {
            let session = DocumentSession(id: file.id, world: world)
            self.session = session
            await session.start()
        }
        .onChange(of: world.documents[file.id]) { session?.follow() }
        .onDisappear { session?.finish() }
        .alert("Link", isPresented: $linkAsk) {
            TextField("https://", text: $linkURL).textInputAutocapitalization(.never).keyboardType(.URL).autocorrectionDisabled()
            Button("Cancel", role: .cancel) {}
            Button(linkURL.isEmpty ? "Remove" : "Apply") { controller.run(.link, argument: linkURL.trimmingCharacters(in: .whitespaces)) }
        }
    }

    // MARK: Content

    @ViewBuilder private func content(_ session: DocumentSession) -> some View {
        let showChanges = session.canCompare && segment == .changes
        notes(session)
        if session.canCompare {
            Picker("Document view", selection: $segment) {
                ForEach(Segment.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16).padding(.top, 8)
        }
        if session.loadFailed {
            ContentUnavailableView("This document is no longer here", systemImage: "doc.text", description: Text("It may have been deleted."))
        } else if let loaded = session.loaded {
            if mode == "rich" && !showChanges { formatBar(session) }
            ZStack {
                if showChanges { changes(session) }
                editor(session, loaded: loaded).opacity(showChanges ? 0 : 1).allowsHitTesting(!showChanges)
            }
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder private func editor(_ session: DocumentSession, loaded: DocumentSession.Loaded) -> some View {
        if DocumentEditorWebView.pageURL == nil {
            Text("The editor is not built into this app. Run scripts/build/doc-editor-ios.mjs and build again.")
                .text(.sm).foregroundStyle(Theme.fgMuted).padding(24)
        } else {
            DocumentEditorWebView(markdown: loaded.markdown, resetKey: loaded.key, editable: session.saveState != .conflict && session.busy == nil, controller: controller) { event in
                switch event {
                case .change(let markdown): session.edit(markdown)
                case .mode(let value): mode = value
                case .state(let value): format = value
                case .ready: break
                }
            }
        }
    }

    /// The grey lines under the bar: who proposed what, where the document is written, the status, a failure.
    @ViewBuilder private func notes(_ session: DocumentSession) -> some View {
        let agentName = world.agent(session.draft?.author?.agentId)?.name ?? "An agent"
        VStack(alignment: .leading, spacing: 2) {
            if session.isReview {
                Text("\(agentName) proposed changes\(session.draft?.summary.map { " · \($0)" } ?? "")")
            }
            if let target = session.view?.target {
                Text("Will be written to \(world.appName(target.appId)) after approval")
            }
            if session.saveState == .conflict {
                Text("Changed elsewhere — reload").foregroundStyle(Theme.danger)
            } else if let status = statusWord(session) {
                Text(status).accessibilityIdentifier("document-status")
            }
            if let error = session.actionError {
                Text(error).foregroundStyle(Theme.danger).accessibilityIdentifier("document-error")
            }
        }
        .text(.xs).foregroundStyle(Theme.fgSubtle)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16).padding(.top, 8)
    }

    private func statusWord(_ session: DocumentSession) -> String? {
        switch session.saveState {
        case .saving: "Saving…"
        case .error: "Not saved"
        case .saved where !session.dirty: "Saved"
        default: session.dirty ? "Unsaved changes" : nil
        }
    }

    private func changes(_ session: DocumentSession) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                ForEach(Array(BlockDiff.diff(saved: session.headMarkdown ?? "", draft: session.text).enumerated()), id: \.offset) { _, block in
                    Text(block.text)
                        .font(.system(.footnote, design: .monospaced))
                        .strikethrough(block.kind == .removed)
                        .foregroundStyle(block.kind == .same ? Theme.fgMuted : block.kind == .removed ? Theme.fgSubtle : Theme.fg)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(block.kind == .added ? Theme.success.opacity(0.16) : .clear, in: .rect(cornerRadius: Radius.md))
                        .accessibilityLabel("\(block.kind == .added ? "Added: " : block.kind == .removed ? "Removed: " : "")\(block.text)")
                }
            }
            .padding(16)
        }
    }

    // MARK: Formatting bar

    private static let bar: [(EditorCommand, String, String)] = [
        (.undo, "arrow.uturn.backward", "Undo"), (.redo, "arrow.uturn.forward", "Redo"),
        (.heading1, "textformat.size.larger", "Heading 1"), (.heading2, "textformat.size", "Heading 2"),
        (.bold, "bold", "Bold"), (.italic, "italic", "Italic"), (.strike, "strikethrough", "Strikethrough"),
        (.code, "chevron.left.forwardslash.chevron.right", "Inline code"),
        (.bulletList, "list.bullet", "Bulleted list"), (.orderedList, "list.number", "Numbered list"), (.taskList, "checklist", "Task list"),
        (.blockquote, "text.quote", "Quote"), (.codeBlock, "curlybraces", "Code block"), (.table, "tablecells", "Table"),
    ]

    private func formatBar(_ session: DocumentSession) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                ForEach(Self.bar, id: \.0) { command, symbol, label in
                    let on = format[command.rawValue] == true && command != .undo && command != .redo
                    Button { controller.run(command) } label: { Label(label, systemImage: symbol).labelStyle(.iconOnly).frame(width: 36, height: 36) }
                        .foregroundStyle(Theme.fg)
                        .background(on ? Theme.muted : .clear, in: .rect(cornerRadius: Radius.md))
                        .disabled(session.saveState == .conflict || ((command == .undo || command == .redo) && format[command.rawValue] == false))
                        .accessibilityIdentifier("format-\(command.rawValue)")
                }
                Button { linkURL = ""; linkAsk = true } label: { Label("Link", systemImage: "link").labelStyle(.iconOnly).frame(width: 36, height: 36) }
                    .foregroundStyle(Theme.fg)
                    .background(format["link"] == true ? Theme.muted : .clear, in: .rect(cornerRadius: Radius.md))
            }
            .padding(.horizontal, 12).padding(.vertical, 4)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Formatting")
    }

    // MARK: Top bar

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button("Close", systemImage: "xmark") { dismiss() }.accessibilityIdentifier("Close")
        }
        if let session {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if let agentId = file.createdByAgentId ?? session.draft?.author?.agentId {
                    Button("Talk about this document", systemImage: "bubble.left") { Task { await talk(agentId) } }.disabled(openingChat)
                }
                if session.draft != nil {
                    Menu {
                        Button(session.isReview ? "Decline" : "Discard", role: .destructive) { Task { await session.decline() } }
                    } label: { Label("More", systemImage: "ellipsis") }
                    .disabled(session.busy != nil)
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                if session.saveState == .conflict {
                    Button("Reload") { Task { await session.reload() } }
                } else if session.dirty || session.draft != nil {
                    Button(session.isReview ? "Approve & save" : "Save") { Task { await session.approve() } }
                        .disabled(session.busy != nil || session.loaded == nil)
                        .accessibilityIdentifier("document-save")
                }
            }
        }
    }

    private func talk(_ agentId: String) async {
        openingChat = true
        defer { openingChat = false }
        if let conversation = try? await world.documentConversation(file.id, agentId: agentId) { chat = conversation.id }
    }
}

extension World {
    /// An app's display name for a document's external target (its catalog id when the catalog is not loaded).
    func appName(_ id: String) -> String { apps?.first { $0.id == id }?.name ?? id }
}
