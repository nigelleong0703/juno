import SwiftUI

// MARK: - Feed (动态): what agents found that needs no action from you. Muse's feed cards.

struct FeedPage: View {
    @Environment(World.self) private var world
    @State private var forwarding: FeedPost?
    @State private var declining: FeedPost?

    var body: some View {
        // "Not interested" posts stay hidden: the server keeps the signal and the post carries it back.
        let posts = world.feed.filter { ($0.feedback != "less") && (world.scope == nil || $0.agentId == world.scope) }
        ScrollViewReader { proxy in
        List {
            TabHeading(title: "Feed")
                .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            ForEach(posts) { row($0) }
        }
        .listStyle(.plain)
        .refreshable { await world.reloadFeed() }
        .onAppear { focus(proxy) }
        .onChange(of: world.feedFocus) { _, _ in focus(proxy) }
        .onChange(of: posts.count) { _, _ in focus(proxy) }
        .overlay {
            if posts.isEmpty {
                ContentUnavailableView("Nothing new yet", systemImage: "newspaper",
                                       description: Text("Ask an agent to post here, e.g. “Every morning, send me AI news.”"))
            }
        }
        .overlay(alignment: .top) {
            if let toast = world.feedToast {
                HStack(spacing: 12) {
                    Text(toast.text).text(.base, .medium).foregroundStyle(Theme.fg).frame(maxWidth: .infinity, alignment: .leading)
                    Button("Undo") { world.undoDismiss() }.text(.base, .semibold).foregroundStyle(Theme.fg)
                        .accessibilityIdentifier("feed-undo")
                }
                .toastChrome()
            } else if let notice = world.feedNotice {
                Label(notice, systemImage: "checkmark.circle.fill").text(.base, .medium).foregroundStyle(Theme.fg).toastChrome()
            }
        }
        .animation(.snappy, value: world.feedNotice)
        .animation(.snappy, value: world.feedToast)
        .sheet(item: $forwarding) { FeedForwardSheet(post: $0).junoSheetPresentation(long: true) }
        .sheet(item: $declining) { FeedReasonSheet(post: $0).junoSheetPresentation() }
        .tabHeader("Feed")
        }
    }

    private func row(_ post: FeedPost) -> some View {
        FeedRow(post: post, highlighted: world.feedFocus == post.id) { world.postPage = post.id }
            .feedMenu(post, onForward: { forwarding = post }, onDecline: { declining = post })
            .agentZoomSource("feed-\(post.id)")
            .id(post.id)
            .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }

    /// Opened from a chat's "Posted to Feed" card: scroll that post to the middle; the highlight fades after a few seconds.
    private func focus(_ proxy: ScrollViewProxy) {
        guard let id = world.feedFocus, world.feed.contains(where: { $0.id == id }) else { return }
        withAnimation { proxy.scrollTo(id, anchor: .center) }
        Task { try? await Task.sleep(for: .seconds(3)); if world.feedFocus == id { world.feedFocus = nil } }
    }
}

/// A post's picture: aspect-fill in whatever frame it is given; nothing at all when it cannot load (a failed or
/// missing image never leaves a grey hole). `placeholder` shows instead of nothing for compact uses.
struct FeedImage<Placeholder: View>: View {
    var url: URL?
    @ViewBuilder var placeholder: Placeholder
    var body: some View {
        if let url {
            RemoteImage(url: url) { phase in
                if let image = phase.image { image.resizable().scaledToFill() }
                else if phase.error { placeholder }
                else { Theme.tile }
            }
        } else { placeholder }
    }
}

/// The long-press menu of a post: Reply (the agent's chat with the post quoted), Forward…, Open source, Not interested.
private struct FeedMenu: ViewModifier {
    @Environment(World.self) private var world
    var post: FeedPost
    var onForward: () -> Void
    var onDecline: () -> Void

    func body(content: Content) -> some View {
        content.contextMenu {
            if world.directConversation(for: post.agentId ?? "") != nil {
                Button { world.replyToPost(post) } label: { Label("Reply", systemImage: "arrowshape.turn.up.left") }
            }
            Button(action: onForward) { Label("Forward…", systemImage: "arrowshape.turn.up.right") }
            if let source = post.sourceUrl.flatMap(URL.init(string:)) {
                Button { UIApplication.shared.open(source) } label: { Label("Open source", systemImage: "safari") }
            }
            Button(role: .destructive, action: onDecline) { Label("Not interested", systemImage: "hand.thumbsdown") }
        }
    }
}

extension View {
    fileprivate func feedMenu(_ post: FeedPost, onForward: @escaping () -> Void, onDecline: @escaping () -> Void) -> some View {
        modifier(FeedMenu(post: post, onForward: onForward, onDecline: onDecline))
    }
    func toastChrome() -> some View {
        padding(.horizontal, 14).padding(.vertical, 10)
            .background(Theme.card, in: .rect(cornerRadius: Radius.xl))
            .overlay(RoundedRectangle(cornerRadius: Radius.xl).stroke(Theme.border, lineWidth: 1))
            .padding(.horizontal, 16).padding(.top, 8)
            .transition(.move(edge: .top).combined(with: .opacity))
    }
}

/// "Why isn't this for you?": the reason goes to the agent with the "less" signal.
struct FeedReasonSheet: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var post: FeedPost
    var fromPost = false
    @State private var other = false
    @State private var note = ""

    private static let reasons: [(key: String, text: String)] = [
        ("topic", "Not interested in this topic"), ("frequency", "Too often"), ("known", "Already knew this"), ("source", "Not a good source"),
    ]

    var body: some View {
        NavigationStack {
            List {
                if other {
                    Section {
                        TextField("What would you change?", text: $note).accessibilityIdentifier("feed-reason-note")
                            .onChange(of: note) { _, new in if new.count > 200 { note = String(new.prefix(200)) } }
                        Button("Done") { choose("other", note.trimmingCharacters(in: .whitespacesAndNewlines)) }
                    }
                } else {
                    ForEach(Self.reasons, id: \.key) { reason in
                        Button(reason.text) { choose(reason.key, nil) }.accessibilityIdentifier("feed-reason-\(reason.key)")
                    }
                    Button("Something else…") { other = true }.accessibilityIdentifier("feed-reason-other")
                }
            }
            .foregroundStyle(Theme.fg)
            .webGrouped().listRowBackground(Theme.muted)
            .pageHeader("Why isn’t this for you?")
            .toolbar { CloseButton() }
        }
    }

    private func choose(_ reason: String, _ note: String?) {
        world.dismissPost(post, reason: reason, note: note?.isEmpty == true ? nil : note)
        dismiss()
        if fromPost { world.postPage = nil }
    }
}

/// Pick any chat and send the post there (title, summary, source link) through the normal send path.
struct FeedForwardSheet: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var post: FeedPost

    var body: some View {
        NavigationStack {
            List(world.recentConversations) { conversation in
                Button {
                    world.forwardPost(post, to: conversation.id)
                    world.feedNotice = "Sent to \(ConversationRow.title(conversation, world))"
                    Task { try? await Task.sleep(for: .seconds(3)); world.feedNotice = nil }
                    dismiss()
                } label: { ConversationRow(conversation: conversation) }
                .buttonStyle(.plain)
                // The Chats home's row: its own 16pt margins, no rule above the first, the rule under it starting at 64pt.
                .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                .listRowBackground(Color.clear)
                .listRowSeparator(conversation.id == world.recentConversations.first?.id ? .hidden : .automatic, edges: .top)
                .alignmentGuide(.listRowSeparatorLeading) { _ in 64 }
                .accessibilityIdentifier("forward-\(conversation.id)")
            }
            .listStyle(.plain)
            .webGrouped()
            .overlay { if world.recentConversations.isEmpty { ContentUnavailableView("No chats", systemImage: "bubble.left") } }
            .pageHeader("Forward to")
            .toolbar { CloseButton() }
        }
    }
}

/// A square thumbnail; nothing at all when the picture cannot load.
private struct FeedThumb: View {
    var url: URL
    var size: CGFloat = 76
    @State private var failed = false
    var body: some View {
        if !failed {
            Color.clear.frame(width: size, height: size)
                .overlay {
                    RemoteImage(url: url) { phase in
                        if let image = phase.image { image.resizable().scaledToFill() }
                        else if phase.error { Color.clear.onAppear { failed = true } }
                        else { Theme.tile }
                    }
                }
                .clipShape(.rect(cornerRadius: 10))
        }
    }
}

/// The post page's cover picture: the 16:9 card photo when it loads, and nothing at all when it
/// cannot (a failed or missing picture never leaves a blank frame or an orphan caption).
private struct FeedDetailCover: View {
    var url: URL
    var caption: String?
    @State private var failed = false

    var body: some View {
        if !failed {
            VStack(alignment: .leading, spacing: 6) {
                Color.clear
                    .aspectRatio(16.0 / 9.0, contentMode: .fit)
                    .overlay {
                        RemoteImage(url: url) { phase in
                            if let image = phase.image { image.resizable().scaledToFill() }
                            else if phase.error { Color.clear.onAppear { failed = true } }
                            else { Theme.tile }
                        }
                    }
                    .clipShape(.rect(cornerRadius: Radius.lg))
                    .accessibilityLabel(caption ?? "")
                if let caption, !caption.isEmpty {
                    Text(caption).text(.sm).foregroundStyle(Theme.fgSubtle).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

/// "Name · 2h" with a small avatar.
private struct FeedByline: View {
    @Environment(World.self) private var world
    var post: FeedPost
    var body: some View {
        HStack(spacing: 6) {
            AvatarView(agent: world.agent(post.agentId), size: 18)
            Text([world.agent(post.agentId)?.name ?? "Agent", Fmt.ago(post.createdAt)].filter { !$0.isEmpty }.joined(separator: " · "))
                .text(.xs).foregroundStyle(Theme.fgSubtle).lineLimit(1)
        }
    }
}

/// One post as a compact card: byline, title, summary, and a square thumbnail on the right.
struct FeedRow: View {
    var post: FeedPost
    var highlighted = false
    var onOpen: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                FeedByline(post: post)
                if let title = post.title, !title.isEmpty {
                    Text(title).text(.md, .semibold).foregroundStyle(Theme.fg).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                }
                if let text = post.cardSummary {
                    Text(text).text(.sm).foregroundStyle(Theme.fgMuted).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let url = post.imageUrl.flatMap(URL.init(string:)) { FeedThumb(url: url) }
        }
        .feedCard()
        // The highlight is drawn inside the card's own bounds: it never changes the card's insets or width.
        .overlay(RoundedRectangle(cornerRadius: Radius.xl).strokeBorder(Theme.fg.opacity(highlighted ? 0.5 : 0), lineWidth: 2))
        .contentShape(.rect)
        .onTapGesture(perform: onOpen)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("feed-card-\(post.id)")
        .animation(.easeOut(duration: 0.3), value: highlighted)
    }
}

extension View {
    /// The card surface shared by Feed posts, Ideas and For-you suggestions: Theme.card, Radius.xl, a 1pt border, 14pt inside.
    func feedCard() -> some View {
        padding(14)
            .background(Theme.card, in: .rect(cornerRadius: Radius.xl))
            .overlay(RoundedRectangle(cornerRadius: Radius.xl).stroke(Theme.border, lineWidth: 1))
    }
}

/// The post page's header: avatar, name, "from <source> · time".
private struct FeedAgentRow: View {
    var agent: Agent?
    var at: Date?
    var source: String?

    var body: some View {
        HStack(spacing: 10) {
            AvatarView(agent: agent, size: AvatarSize.lg)
            VStack(alignment: .leading, spacing: 0) {
                Text(agent?.name ?? "Agent").text(.sm, .medium).foregroundStyle(Theme.fg)
                Text([source.map { "from \($0)" }, Fmt.ago(at)].compactMap { $0 }.joined(separator: " · ")).text(.xs).foregroundStyle(Theme.fgSubtle).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
    }
}

/// A post opened in full: title, picture, summary, the markdown write-up and the display blocks.
struct FeedPostDetail: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    @State private var forwarding: FeedPost?
    @State private var declining: FeedPost?
    /// Where the post's own title ends, in the page's content; the bar's title fades in as it scrolls away.
    @State private var titleBottom: CGFloat = 60
    var postId: String

    var body: some View {
        NavigationStack {
            ScrollView {
                if let post = world.feed.first(where: { $0.id == postId }) {
                    VStack(alignment: .leading, spacing: 16) {
                        FeedAgentRow(agent: world.agent(post.agentId), at: post.createdAt, source: world.routine(post.routineId)?.name)
                        if let title = post.title, !title.isEmpty {
                            Text(title).text(.xl, .semibold).foregroundStyle(Theme.fg)
                                .fixedSize(horizontal: false, vertical: true)
                                .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named("post")).maxY } action: { titleBottom = $0 }
                        }
                        if let url = post.imageUrl.flatMap(URL.init(string:)) {
                            FeedDetailCover(url: url, caption: post.imageCaption)
                        }
                        if let summary = post.summary, !summary.isEmpty {
                            Text(summary).text(.md).foregroundStyle(Theme.fg).fixedSize(horizontal: false, vertical: true)
                        }
                        if let body = post.body, !body.isEmpty {
                            AgentMarkdown(text: body).foregroundStyle(Theme.fg)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if let ui = post.ui { UiMessageCard(doc: ui) }
                        if let source = post.sourceUrl.flatMap(URL.init(string:)) {
                            Link(destination: source) {
                                Text("Source: \(source.host()?.replacingOccurrences(of: "www.", with: "") ?? source.absoluteString)")
                                    .text(.sm).foregroundStyle(Theme.fgMuted).underline()
                            }
                        }
                        usefulRow(post)
                    }
                    .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .coordinateSpace(name: "post")
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            .safeAreaInset(edge: .bottom) { replyBar }
            .pageHeader("Post", revealAfter: titleBottom - 24)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Close", systemImage: "xmark") { dismiss() }.accessibilityIdentifier("feed-post-close") }
                ToolbarItem(placement: .topBarTrailing) {
                    if let post = world.feed.first(where: { $0.id == postId }) {
                        Button { forwarding = post } label: { Image(systemName: "arrowshape.turn.up.right") }
                            .accessibilityLabel("Forward")
                    }
                }
            }
            .sheet(item: $forwarding) { FeedForwardSheet(post: $0).junoSheetPresentation(long: true) }
            .sheet(item: $declining) { FeedReasonSheet(post: $0, fromPost: true).junoSheetPresentation() }
            .tint(Theme.fg)
        }
    }

    /// The quiet end of the page: was it worth it? "Useful" tells the agent to post more like it, "Not for me" asks why.
    @ViewBuilder private func usefulRow(_ post: FeedPost) -> some View {
        Divider()
        if post.feedback == "more" {
            Label("Thanks — \(world.agent(post.agentId)?.name ?? "your agent") will post more like this", systemImage: "checkmark")
                .text(.sm).foregroundStyle(Theme.fgMuted)
        } else {
            HStack(spacing: 8) {
                Text("Was this useful?").text(.sm).foregroundStyle(Theme.fgMuted)
                Spacer(minLength: 0)
                Button("Useful") { world.sendFeedback(post.id, .more) }
                    .buttonStyle(WebButton(variant: .secondary, size: .xs)).accessibilityIdentifier("feed-useful")
                Button("Not for me") { declining = post }
                    .buttonStyle(WebButton(variant: .secondary, size: .xs)).accessibilityIdentifier("feed-not-for-me")
            }
        }
    }

    /// Looks like the chat composer; tapping it opens the agent's chat with this post quoted and the keyboard up.
    @ViewBuilder private var replyBar: some View {
        if let post = world.feed.first(where: { $0.id == postId }), world.directConversation(for: post.agentId ?? "") != nil {
            let name = world.agent(post.agentId)?.name ?? "agent"
            Button { world.postPage = nil; world.replyToPost(post) } label: {
                HStack {
                    Text("Reply to \(name)…").foregroundStyle(Theme.fgMuted)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 16).frame(minHeight: 40).contentShape(.capsule)
            }
            .buttonStyle(.plain)
            .glassEffect(.regular.interactive(), in: .capsule)
            .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 8)
            .accessibilityIdentifier("feed-reply-bar")
        }
    }
}
