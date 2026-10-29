import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

// MARK: - Chat tab: NavigationSplitView — sidebar is every chat, detail is the open chat

/// iPad (regular width): the chat list beside the open chat. On iPhone the Chats tab is `ChatsNavigationController`.
struct ChatScreen: View {
    @Environment(World.self) private var world
    /// Which column the compact layout would show.
    @State private var column = NavigationSplitViewColumn.detail

    var body: some View {
        NavigationSplitView(preferredCompactColumn: $column) {
            ChatListColumn()
        } detail: {
            NavigationStack {
                Group {
                    if let id = world.currentConversationId {
                        ConversationView(conversationId: id).id(id)
                    } else {
                        ContentUnavailableView("No chat selected", systemImage: "bubble.left.and.bubble.right")
                    }
                }
                .junoDestinations()
            }
        }
    }
}

/// The native chat list (large title, search) as the split view's sidebar.
private struct ChatListColumn: UIViewControllerRepresentable {
    @Environment(World.self) private var world
    func makeUIViewController(context: Context) -> UINavigationController {
        let nav = UINavigationController(rootViewController: ChatListViewController(world: world))
        nav.navigationBar.prefersLargeTitles = false
        return nav
    }
    func updateUIViewController(_ nav: UINavigationController, context: Context) {}
}

/// Two overlapping avatars for a group chat (web AgentAvatarGroup, max 2).
struct GroupAvatar: View {
    var agents: [Agent]
    var size: CGFloat
    var body: some View {
        ZStack(alignment: .topLeading) {
            AvatarView(agent: agents.first, size: size * 0.72)
            if agents.count > 1 {
                AvatarView(agent: agents[1], size: size * 0.72).offset(x: size * 0.28, y: size * 0.28)
            }
        }
        .frame(width: size, height: size, alignment: .topLeading)
    }
}

// MARK: - Conversation: a ChatLayout list renders the transcript; the header and composer are SwiftUI bars

struct ConversationView: View {
    @Environment(World.self) private var world
    /// Set by the Chats tab's navigation controller: pushes an in-row route onto it.
    @Environment(\.pushRoute) private var pushRoute
    var conversationId: String
    @Environment(\.composerHosted) private var composerHosted
    /// Shared with the composer (its text, attachments, menu) and the list. `ChatHostingController` passes the one its
    /// own composer uses; elsewhere the view makes its own and draws the composer itself.
    @State private var store: ChatStore
    /// Rows are hosted by UIKit cells, outside any NavigationStack: inside a SwiftUI stack they ask for a push through here.
    @State private var route: Route?

    init(conversationId: String, store: ChatStore = ChatStore()) {
        self.conversationId = conversationId
        _store = State(initialValue: store)
    }

    var body: some View {
        let world = world
        let conversation = world.conversation(conversationId)
        let agents = (conversation?.agentIds ?? []).compactMap(world.agent)
        let isGroup = conversation?.kind == "room"
        let items = world.transcript(conversationId)
        let activeRunId = world.activeRuns(in: conversationId).first {
            $0.parentRunId == nil && ["running", "queued"].contains($0.status ?? "")
        }?.id
        let context = ChatContext(world: world, conversationId: conversationId, isGroup: isGroup,
                                  accent: world.accent(for: conversationId), openRoute: { if let pushRoute { pushRoute($0) } else { route = $0 } })

        // Its own view: the transcript is rebuilt only when the chat's data changes, not when the composer, its "+"
        // menu or the header measure change (re-running the whole feed on each of those made the menu and sending lag).
        ChatTranscript(store: store, context: context, conversationId: conversationId)
        .equatable()
        .ignoresSafeArea()
        // Outside the bars' safe area so it stays hit-testable; their insets place it above the composer.
        .overlay(alignment: .bottomTrailing) {
            if !composerHosted { ChatJumpButton(store: store).padding(.trailing, 16).padding(.bottom, 8) }
        }
        .overlay {
            // While the agent writes the chat's first words (its greeting) the typing row stands in for the empty state.
            if items.isEmpty, world.chatLoaded(conversationId), activeRunId == nil, agents.first?.status != "working" {
                ContentUnavailableView("No messages yet", systemImage: "bubble.left",
                                       description: Text(isGroup ? "Mention an agent to start the conversation."
                                                                 : "Say hello — \(agents.first?.name ?? "your agent") is ready when you are."))
            }
        }
        .safeAreaBar(edge: .top) {
            ChatSystemBar {
                // The avatar's lower half hangs below the navigation bar, over this bar: the navigation bar would swallow
                // taps there, so the part below it is the same tap target as the name, one button with no gap between.
                headerMenu(agents: agents, isGroup: isGroup) {
                    VStack(spacing: 0) {
                        Color.clear.frame(width: AvatarSize.chatHeader, height: AvatarSize.chatHeader - 54).contentShape(.rect)
                        VStack(spacing: 1) {
                            HStack(spacing: 4) {
                                Text(isGroup || conversation?.isChannelChat == true ? (conversation?.title ?? "Group") : (agents.first?.name ?? "Chat")).text(.sm, .medium)
                                if let platform = ChannelPlatform(kind: conversation?.channel?.kind) {
                                    ChannelBadge(platform: platform, size: 14).accessibilityLabel("via \(platform.name)").accessibilityHidden(false)
                                }
                                Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.fgMuted)
                            }
                            .foregroundStyle(Theme.fg)
                            // Persistent presence only (the dot on the avatar and this line); the run's activity is the typing bubble.
                            if !isGroup, let line = presence(agents.first, busy: activeRunId != nil) {
                                Text(line).text(.xs).foregroundStyle(Theme.fgSubtle)
                            }
                        }
                        .padding(.horizontal, 12).padding(.vertical, 5)
                        // A light backing under the glass: over a dark page (an artifact) clear glass left the dark name unreadable.
                        .background(Theme.canvas.opacity(0.85), in: .capsule)
                        .glassEffect(.regular, in: .capsule)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.bottom, 8)
                .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxY } action: { store.headerBottom = $0 }
                .environment(world)
            }
        }
        .modifier(SwiftUIComposerBar(store: store, conversationId: conversationId))
        .toolbar {
            ToolbarItem(placement: .principal) {
                // The lower half extends below the bar; the avatar stays between its navigation controls.
                ZStack {
                    Circle().fill(.clear).glassEffect(.regular, in: .circle).allowsHitTesting(false)
                    headerMenu(agents: agents, isGroup: isGroup) {
                        // The zoom source sits on the avatar only: on the glass it flattened the glass over the bean.
                        Group {
                            if isGroup {
                                GroupAvatar(agents: agents, size: AvatarSize.chatHeader - 8)
                            } else {
                                AvatarView(agent: agents.first, size: AvatarSize.chatHeader - 8)
                            }
                        }
                        .frame(width: AvatarSize.chatHeader, height: AvatarSize.chatHeader)
                        .contentShape(.circle)
                        .agentZoomSource(isGroup ? "chat-group-\(conversationId)" : "chat-\(agents.first?.id ?? "")")
                    }
                }
                .frame(width: AvatarSize.chatHeader, height: AvatarSize.chatHeader)
                .overlay(alignment: .topTrailing) {
                    if let agent = agents.first, !isGroup, AgentDot.shows(agent.status, needsYou: !world.needsYou(of: agent.id).isEmpty) {
                        AgentDot(status: agent.status, needsYou: !world.needsYou(of: agent.id).isEmpty, size: 12)
                            .padding(3)
                            .background(Theme.canvas, in: .circle)
                    }
                }
                .frame(height: 44, alignment: .top)
            }
            .sharedBackgroundVisibility(.hidden)
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    if let a = agents.first { world.sheet = .workspace(conversationId: conversationId, agentId: a.id) }
                } label: { Label("Computer", systemImage: "desktopcomputer") }
            }
        }
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $route) { RouteDestination(route: $0) }
        .background(alignment: .top) {
            if let accent = world.accent(for: conversationId) {
                LinearGradient(colors: [accent.opacity(0.16), accent.opacity(0)], startPoint: .top, endPoint: .bottom)
                    .frame(height: 260).ignoresSafeArea()
            }
        }
        .background(Theme.canvas)
        .environment(\.agentAccent, world.accent(for: conversationId))
        .noDrawerSwipe()
        .onAppear { world.loadItems(conversationId) }
        .task(id: world.conversation(conversationId) != nil) { openLaunchSheet() }
    }

    /// Persistent presence under the agent's name: reconnecting, what it is doing, or its status.
    private func presence(_ agent: Agent?, busy: Bool) -> String? {
        guard let agent else { return nil }
        if world.api != nil, World.showsReconnecting(live: world.streamLive, now: Date(), graceUntil: world.streamGraceUntil, busy: busy) {
            return "Reconnecting…"
        }
        if busy { return "Working…" }
        if let doing = world.doing[agent.id], !doing.isEmpty { return doing }
        return agent.status.map(Fmt.status)
    }

    /// Tap target shared by the figure and the name: one agent → its card; a group → choose whose card.
    @ViewBuilder private func headerMenu<L: View>(agents: [Agent], isGroup: Bool, @ViewBuilder label: () -> L) -> some View {
        let source = isGroup ? "chat-group-\(conversationId)" : "chat-\(agents.first?.id ?? "")"
        if isGroup {
            Menu {
                ForEach(agents) { a in
                    Button("\(a.name ?? "") · \(Fmt.status(a.status))") { world.openAgentPage(a.id, from: source) }
                }
            } label: { label() }
            .buttonStyle(.plain)
        } else {
            Button { if let a = agents.first { world.openAgentPage(a.id, from: source) } } label: { label() }
                .buttonStyle(.plain)
                .accessibilityLabel("\(agents.first?.name ?? "Agent") card")
        }
    }

    /// `-sheet workspace|card` on launch opens that sheet (used for Simulator screenshots).
    private func openLaunchSheet() {
        guard let a = world.conversation(conversationId)?.agentIds?.first else { return }
        switch UserDefaults.standard.string(forKey: "sheet") {
        case "workspace": world.sheet = .workspace(conversationId: conversationId, agentId: a)
        case "card": world.openAgentPage(a, from: "chat-\(a)")
        default: break
        }
        UserDefaults.standard.removeObject(forKey: "sheet")
    }
}

/// Draws the composer as a SwiftUI bottom bar (iPad split, previews). On iPhone `ChatHostingController` hosts
/// `ChatComposerBar` on the keyboard layout guide instead, which follows an interactive keyboard dismissal.
private struct SwiftUIComposerBar: ViewModifier {
    @Environment(\.composerHosted) private var composerHosted
    var store: ChatStore
    var conversationId: String

    func body(content: Content) -> some View {
        if composerHosted {
            content
        } else {
            content.safeAreaBar(edge: .bottom) {
                ChatComposerBar(store: store, conversationId: conversationId)
                    .padding(.bottom, 8)
                    .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minY } action: { store.composerTop = $0 }
            }
        }
    }
}

/// The round jump-to-latest button; it keeps its place and fades, so a host can give it a fixed size.
struct ChatJumpButton: View {
    var store: ChatStore
    var body: some View {
        let show = store.showJump
        JumpButton { store.jumpToLatest() }
            .scaleEffect(show ? 1 : 0.5)
            .opacity(show ? 1 : 0)
            .allowsHitTesting(show)
            .animation(.snappy, value: show)
    }
}

/// The provider notice and the composer, with what sending needs from the conversation.
struct ChatComposerBar: View {
    @Environment(World.self) private var world
    var store: ChatStore
    var conversationId: String

    var body: some View {
        @Bindable var store = store
        GlassEffectContainer(spacing: 6) {
            VStack(spacing: 6) {
                ModelProviderNotice(conversationId: conversationId)
                if let platform = ChannelPlatform(kind: world.conversation(conversationId)?.channel?.kind) {
                    // The agent talks on the platform; the owner only watches here.
                    Text("This chat happens in \(platform.name). Reply there.")
                        .text(.sm).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity).padding(.vertical, 12)
                } else {
                    Composer(draft: $store.draft, onSend: send, conversationId: conversationId, store: store)
                }
            }
        }
        .environment(\.agentAccent, world.accent(for: conversationId))
    }

    /// The composer's text, attachments, mentions and reply quote become one message.
    private func send() {
        let extras = store.extras
        let text = store.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !extras.files.isEmpty else { return }
        let isGroup = world.conversation(conversationId)?.kind == "room"
        let quote = world.takeReplyQuote(in: conversationId)
        let mentions = isGroup ? Mentions.build(text: text, picked: extras.mentions) : []
        world.send(quote + text, in: conversationId, files: extras.files, mentions: mentions)
        store.draft = ""
        extras.entries = []
        extras.mentions = []
    }
}

/// One transcript row: the item's own view (ItemView), swipe-to-reply on messages, or the typing row. Padding
/// keeps the rows off the screen edges. It fills the cell's width: a hosted cell must not size to its content.
struct ChatRow: View {
    @Environment(World.self) private var world
    @Environment(\.rowResized) private var rowResized
    @Environment(\.rowTouched) private var rowTouched
    /// Until the row has been on screen once, nothing in it animates: it appears at its final size and look.
    @State private var appeared = false
    let entry: ChatEntry
    var conversationId: String
    var isGroup: Bool

    var body: some View {
        VStack(spacing: 6) {
            if let day = entry.dayStart { DateSeparator(date: day) }
            Group {
                if let item = entry.item {
                    if item.type == "user_message" || item.type == "agent_message" {
                        ItemView(item: item, showAuthor: isGroup && !entry.continuesGroup).swipeToReply { world.replyTo[conversationId] = item }
                    } else {
                        ItemView(item: item, showAuthor: isGroup)
                    }
                } else if let runId = entry.typingRunId {
                    ChatTypingRow(conversationId: conversationId, runId: runId)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.top, entry.continuesGroup ? 1 : 6).padding(.bottom, entry.groupContinues ? 1 : 6)
        .coordinateSpace(name: "chatRow")
        .transaction { if !appeared { $0.animation = nil } }
        .onAppear { DispatchQueue.main.async { appeared = true } }
        .simultaneousGesture(TapGesture().onEnded { rowTouched?() })
        // The list sized this row before it appeared; if the content turns out different (a card the reader
        // expanded, an image that loaded) the list is told once and sizes it again.
        // Its own height, not the cell's: a cell sized before an expand would otherwise clip the report too.
        .fixedSize(horizontal: false, vertical: true)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { rowResized?($0) }
    }
}

// MARK: - Composer: the web composer pill, built from a system TextField, PhotosPicker and Button

/// The composer's state that is not its text: uploaded attachments and picked mentions. Read when the message is sent.
@Observable final class ComposerExtras {
    /// What is in the composer's strip: each picked file with its upload state. `files` is what the server has.
    var entries: [ComposerAttachment] = []
    var files: [Attachment] { entries.compactMap { if case .done(let file) = $0.state { file } else { nil } } }
    var mentions: [Mention] = []
}

/// One picked photo or file in the composer. The picked bytes stay here for the preview and for a retry.
struct ComposerAttachment: Identifiable {
    enum State { case uploading, done(Attachment), failed }
    let id = UUID()
    var name: String
    var mime: String
    var data: Data
    var preview: UIImage?
    var state: State = .uploading
}

/// A 64pt square in the composer's strip: the picked image (or a document tile), dimmed with a spinner while it
/// uploads, a red exclamation when it failed (tap retries), and a small black "x" at the corner to remove it.
struct AttachmentThumb: View {
    var entry: ComposerAttachment
    var retry: () -> Void
    var remove: () -> Void
    private static let side: CGFloat = 64

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Button { if case .failed = entry.state { retry() } } label: { tile }
                .buttonStyle(.plain)
                .padding(.top, 6).padding(.trailing, 6)
            Button(action: remove) {
                Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(.white)
                    .frame(width: 20, height: 20).background(.black, in: .circle)
                    .overlay(Circle().strokeBorder(Theme.canvas, lineWidth: 1.5))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(entry.name)")
        }
    }

    private var tile: some View {
        ZStack {
            if let image = entry.preview {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                VStack(spacing: 4) {
                    Image(systemName: "doc").font(.system(size: 20)).foregroundStyle(Theme.fgMuted)
                    Text(entry.name).text(.xs).foregroundStyle(Theme.fgMuted).lineLimit(1).truncationMode(.middle)
                }
                .padding(.horizontal, 6)
            }
            switch entry.state {
            case .uploading:
                Color.black.opacity(0.35)
                ProgressView().tint(.white)
            case .failed:
                Color.black.opacity(0.35)
                Image(systemName: "exclamationmark.circle.fill").font(.system(size: 22)).foregroundStyle(Theme.danger)
            case .done: EmptyView()
            }
        }
        .frame(width: Self.side, height: Self.side)
        .background(Theme.muted)
        .clipShape(.rect(cornerRadius: 12))
        .accessibilityLabel(entry.name)
    }
}

struct Composer: View {
    @Environment(World.self) private var world
    @Environment(\.agentAccent) private var accent
    @Binding var draft: String
    var onSend: () -> Void
    var conversationId: String
    var store: ChatStore
    @State private var uploadError: String?
    @State private var picked: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var showCamera = false
    @State private var dictation = Dictation()
    @State private var typing: TypingReporter?
    @FocusState private var focused: Bool
    // A 48pt capsule (the owner found 40pt too small on device) with 6pt around its round controls; the trailing send
    // control is 38x28. They scale with Dynamic Type like the body text they hold.
    @ScaledMetric(relativeTo: .body) private var controlSize: CGFloat = 48
    @ScaledMetric(relativeTo: .body) private var trailingWidth: CGFloat = 38
    @ScaledMetric(relativeTo: .body) private var trailingHeight: CGFloat = 28
    // The "+" and the microphone: round 36pt buttons, centred on a one-line field.
    @ScaledMetric(relativeTo: .body) private var roundSize: CGFloat = 36

    private var text: String { draft }
    private var extras: ComposerExtras { store.extras }

    var body: some View {
        let hasContent = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !extras.entries.isEmpty
        let canSend = hasContent && extras.entries.allSatisfy { if case .done = $0.state { true } else { false } }
        let roomAgents = isRoom ? (world.conversation(conversationId)?.agentIds ?? []).compactMap { world.agent($0) } : []
        VStack(alignment: .leading, spacing: 6) {
            if isRoom, let query = Mentions.activeQuery(in: text) {
                MentionPicker(agents: roomAgents, query: query) { handle, mention in
                    if mention.id != "all" { extras.mentions.append(mention) }
                    draft = Mentions.completing(text, with: handle)
                }
            } else if isRoom, canSend, Mentions.build(text: text, picked: extras.mentions).isEmpty {
                Text("Mention an agent to get a reply").text(.xs).foregroundStyle(Theme.fgMuted).padding(.horizontal, 8)
            }
            if let reply = world.replyTo[conversationId] { ReplyChip(conversationId: conversationId, item: reply) }
            if let uploadError { Text(uploadError).text(.xs).foregroundStyle(Theme.danger).padding(.horizontal, 8) }
            // Like Messages: one glass capsule with the "+" (a Menu) at its leading edge, what you type, and at its
            // trailing end the microphone (empty), the stop button (dictating) or send. Picked files show above the
            // text, inside the capsule. 48pt tall, 16pt from the screen edges (the bubbles' gutter) and 8pt above the
            // home-indicator safe area (or the keyboard).
            // The glass is a sibling layer below the content, not an effect on the view holding the "+" Menu: a Menu
            // inside a glass-effect view makes iOS 26 morph that glass into the menu and the field vanishes.
            ZStack {
            GlassBackground(cornerRadius: controlSize / 2)
            VStack(alignment: .leading, spacing: 0) {
                if !extras.entries.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(extras.entries) { entry in
                                AttachmentThumb(entry: entry, retry: { retry(entry.id) }, remove: { extras.entries.removeAll { $0.id == entry.id } })
                            }
                        }
                        .padding(.horizontal, 10)
                    }
                    .padding(.top, 4)
                }
                HStack(alignment: .bottom, spacing: 0) {
                    Menu {
                        Button { store.attach = .camera } label: { Label("Camera", systemImage: "camera") }
                        Button { store.attach = .photos } label: { Label("Photos", systemImage: "photo.on.rectangle") }
                        Button { store.attach = .files } label: { Label("Files", systemImage: "folder") }
                    } label: {
                        roundGlyph("plus", size: 17, weight: .semibold, color: Theme.fg)
                    }
                    .accessibilityLabel("Add")
                    .accessibilityIdentifier("composer-plus")
                    TextField("Message…", text: $draft, axis: .vertical)
                        .font(.body)
                        .lineLimit(1...6)
                        .focused($focused)
                        .padding(.horizontal, 6)
                        .frame(minHeight: roundSize, alignment: .center)
                    trailingButton(hasContent: hasContent, canSend: canSend)
                        .frame(height: roundSize)
                }
                .padding(6)
            }
            .frame(minHeight: controlSize)
            // A tap anywhere on the capsule types (the field alone is only one line of text tall).
            .contentShape(.rect(cornerRadius: controlSize / 2))
            .onTapGesture { focused = true }
            .zIndex(1)
            }
        }
        // Messages: 28pt from the screen's sides at rest, 16pt once the keyboard is up. The bottom gap is the page's
        // (ChatHostingController): 8pt above the keyboard, the home indicator's inset less 6pt at rest.
        .padding(.horizontal, store.composerSide ?? (focused ? 16 : 28)).padding(.top, 6)
        .animation(store.composerSide == nil ? .snappy(duration: 0.25) : nil, value: focused)
        .photosPicker(isPresented: $showPhotos, selection: $picked, maxSelectionCount: 5, matching: .images)
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in
                let name = "Photo \(extras.entries.count + 1)"
                if let out = ImageCompressor.compress(image) { upload(out.data, name: "\(name).\(out.ext)", mime: out.mime) }
            }
            .ignoresSafeArea()
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            for url in urls.prefix(5 - extras.entries.count) {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                guard let data = try? Data(contentsOf: url) else { continue }
                let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                if let out = ImageCompressor.compress(data, mime: mime) {
                    let base = (url.lastPathComponent as NSString).deletingPathExtension
                    upload(out.data, name: "\(base).\(out.ext)", mime: out.mime)
                } else {
                    upload(data, name: url.lastPathComponent, mime: mime)
                }
            }
        }
        .onChange(of: picked) {
            let items = picked
            picked = []
            for (i, item) in items.enumerated() {
                Task {
                    guard let data = try? await item.loadTransferable(type: Data.self) else { return }
                    let type = item.supportedContentTypes.first
                    let ext = type?.preferredFilenameExtension ?? "jpg"
                    let mime = type?.preferredMIMEType ?? "image/jpeg"
                    let name = "Photo \(extras.entries.count + i + 1)"
                    if let out = ImageCompressor.compress(data, mime: mime) { upload(out.data, name: "\(name).\(out.ext)", mime: out.mime) }
                    else { upload(data, name: "\(name).\(ext)", mime: mime) }
                }
            }
        }
        .onChange(of: store.attach) {
            guard let request = store.attach else { return }
            store.attach = nil
            switch request {
            case .camera: showCamera = true
            case .photos: showPhotos = true
            case .files: showFiles = true
            }
        }
        .onChange(of: dictation.problem) { _, problem in if let problem { uploadError = problem } }
        .onDisappear { dictation.stop(); typing?.stop() }
        .onChange(of: draft) { reportTyping() }
        .onChange(of: focused) { reportTyping() }
        .onAppear {
            if typing == nil {
                typing = TypingReporter { [weak world] id, active in world?.reportTyping(active, in: id) }
            }
            typing?.setConversation(world.conversation(conversationId)?.kind == "direct" ? conversationId : nil)
            if let saved = world.drafts.removeValue(forKey: conversationId) {
                draft = saved
                focused = true
            }
        }
    }

    /// Typing is a focused, non-empty draft; sending, clearing or leaving the field ends it.
    private func reportTyping() {
        if focused && !draft.isEmpty { typing?.report() } else { typing?.stop() }
    }

    private var isRoom: Bool { world.conversation(conversationId)?.kind == "room" }

    private func roundGlyph(_ name: String, size: CGFloat, weight: Font.Weight, color: Color) -> some View {
        Image(systemName: name).font(.system(size: size, weight: weight))
            .foregroundStyle(color)
            .frame(width: roundSize, height: roundSize)
            .background(Theme.muted, in: .circle)
            .contentShape(.circle)
    }

    /// The capsule's trailing button: stop while dictating, send once there is something to send, else the microphone.
    @ViewBuilder private func trailingButton(hasContent: Bool, canSend: Bool) -> some View {
        Group {
            if dictation.listening {
                Button { dictation.toggle(transcribe: world.transcribe) { draft = Dictation.append($0, to: draft) } } label: {
                    Image(systemName: "waveform").font(.system(size: 15, weight: .semibold))
                        .symbolEffect(.variableColor.iterative, isActive: true)
                        .foregroundStyle(accent.map { onColor($0) } ?? Theme.primaryFg)
                        .frame(width: trailingWidth, height: trailingHeight)
                        .background(accent ?? Theme.primary, in: .capsule)
                }
                .accessibilityLabel("Stop dictation")
                .accessibilityIdentifier("composer-stop-dictation")
            } else if dictation.transcribing {
                ProgressView()
                    .frame(width: trailingWidth, height: trailingHeight)
                    .accessibilityLabel("Transcribing")
                    .accessibilityIdentifier("composer-transcribing")
            } else if hasContent {
                Button { onSend() } label: {
                    Image(systemName: "arrow.up").font(.system(size: 16, weight: .bold))
                        .foregroundStyle(canSend ? (accent.map { onColor($0) } ?? Theme.primaryFg) : Theme.fgMuted)
                        .frame(width: trailingWidth, height: trailingHeight)
                        .background(canSend ? (accent ?? Theme.primary) : Theme.muted, in: .capsule)
                }
                .disabled(!canSend)
                .accessibilityLabel("Send")
                .accessibilityIdentifier("composer-send")
            } else {
                Button {
                    uploadError = nil
                    dictation.toggle(transcribe: world.transcribe) { draft = Dictation.append($0, to: draft) }
                } label: {
                    roundGlyph("mic", size: 16, weight: .medium, color: Theme.fg)
                }
                .accessibilityLabel("Dictate")
                .accessibilityIdentifier("composer-mic")
            }
        }
        .transition(.scale(scale: 0.6).combined(with: .opacity))
        .animation(.snappy(duration: 0.2), value: hasContent)
        .animation(.snappy(duration: 0.2), value: dictation.listening)
        .animation(.snappy(duration: 0.2), value: dictation.transcribing)
    }

    /// Up first (10 MB max, 5 per message, server-checked); the thumbnail shows at once and settles when the server has it.
    private func upload(_ data: Data, name: String, mime: String) {
        uploadError = nil
        let preview = mime.hasPrefix("image/") ? UIImage(data: data)?.preparingThumbnail(of: CGSize(width: 192, height: 192)) : nil
        let entry = ComposerAttachment(name: name, mime: mime, data: data, preview: preview)
        extras.entries.append(entry)
        start(entry.id)
    }

    private func retry(_ id: UUID) {
        guard let i = extras.entries.firstIndex(where: { $0.id == id }) else { return }
        extras.entries[i].state = .uploading
        start(id)
    }

    /// A removed entry is gone from the list, so its result is ignored.
    private func start(_ id: UUID) {
        guard let entry = extras.entries.first(where: { $0.id == id }) else { return }
        Task { @MainActor in
            let result: ComposerAttachment.State
            do { result = .done(try await world.upload(entry.data, name: entry.name, mimeType: entry.mime)) }
            catch { result = .failed }
            guard let i = extras.entries.firstIndex(where: { $0.id == id }) else { return }
            extras.entries[i].state = result
        }
    }
}

/// Chat photos are compressed on the device before upload, like WhatsApp/Telegram: long side at most 1600 px (never
/// upscaled), EXIF orientation applied, JPEG 0.8; PNG only when the picture has transparency. GIFs and non-images are
/// left alone (nil), as is anything that cannot be decoded.
enum ImageCompressor {
    static let maxSide = 1600
    static let quality: CGFloat = 0.8
    typealias Output = (data: Data, mime: String, ext: String)

    static func compress(_ data: Data, mime: String) -> Output? {
        guard mime.hasPrefix("image/"), mime != "image/gif",
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maxSide,
              ] as CFDictionary) else { return nil }
        return encode(image)
    }

    /// The camera's photo: UIImage carries its orientation, so redraw it upright at the target size first.
    static func compress(_ image: UIImage) -> Output? {
        let longSide = max(image.size.width, image.size.height) * image.scale
        let ratio = min(1, CGFloat(maxSide) / max(longSide, 1))
        let size = CGSize(width: image.size.width * image.scale * ratio, height: image.size.height * image.scale * ratio)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let upright = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        guard let cg = upright.cgImage else { return nil }
        return encode(cg)
    }

    private static func encode(_ image: CGImage) -> Output? {
        if hasTransparency(image), let png = UIImage(cgImage: image).pngData() { return (png, "image/png", "png") }
        guard let jpeg = UIImage(cgImage: image).jpegData(compressionQuality: quality) else { return nil }
        return (jpeg, "image/jpeg", "jpg")
    }

    private static func hasTransparency(_ image: CGImage) -> Bool {
        switch image.alphaInfo {
        case .none, .noneSkipFirst, .noneSkipLast: return false
        default: break
        }
        let w = image.width, h = image.height
        var pixels = [UInt8](repeating: 0, count: w * h * 4)
        let drawn = pixels.withUnsafeMutableBytes { buf -> Bool in
            guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard drawn else { return false }
        for i in stride(from: 3, to: pixels.count, by: 4) where pixels[i] < 255 { return true }
        return false
    }
}

/// The system camera (UIImagePickerController); hands back the photo taken.
struct CameraPicker: UIViewControllerRepresentable {
    var onPick: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = UIImagePickerController.isSourceTypeAvailable(.camera) ? .camera : .photoLibrary
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.onPick(image) }
            parent.dismiss()
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}

/// The list and the rows it shows. Reads the world (the transcript) and nothing of the composer's state.
private struct ChatTranscript: View, @MainActor Equatable {
    /// The context carries closures, which never compare equal: compare what decides the rows instead.
    static func == (a: Self, b: Self) -> Bool {
        a.conversationId == b.conversationId && a.store === b.store
            && a.context.isGroup == b.context.isGroup && a.context.accent == b.context.accent
    }

    @Environment(World.self) private var world
    let store: ChatStore
    let context: ChatContext
    let conversationId: String

    var body: some View {
        ChatListView(store: store, context: context,
                     entries: ChatFeed.entries(world: world, conversationId: conversationId, items: world.transcript(conversationId)))
    }
}
