import SwiftUI

private struct ChatAvailableWidthKey: EnvironmentKey {
    static let defaultValue: CGFloat = 0
}

extension EnvironmentValues {
    var chatAvailableWidth: CGFloat {
        get { self[ChatAvailableWidthKey.self] }
        set { self[ChatAvailableWidthKey.self] = newValue }
    }
}

// Transcript items, one per web component in packages/app/src/components/{conversation,run,request}.
// Sizes, radii and type come from Theme (tokens.css); the file:line each view mirrors is noted on it.

/// Transcript.tsx's switch.
struct ItemView: View {
    @Environment(World.self) private var world
    var item: Item
    var showAuthor: Bool

    var body: some View {
        switch item.type {
        case "user_message": UserBubble(item: item, showAuthor: showAuthor)
        case "agent_message": AgentBubble(item: item, showAuthor: showAuthor)
        case "run": if let run = world.run(item.runId), World.isFailedRunRow(run) { RunStatusRow(run: run) }
        case "plan": PlanCard(title: world.run(item.runId)?.title ?? "Plan", todos: item.todos ?? [])
        case "request": if let r = world.request(item.requestId) { RequestCard(request: r).padding(.vertical, 2).modifier(MessageWidth(trailing: false)) }
        case "artifact": if let f = world.file(item.artifactId) { ArtifactCard(file: f) }
        case "routine": if let r = world.routine(item.routineId) { RoutineRow(routine: r, change: item.change) }
        case "handoff": HandoffMarker(item: item)
        case "system": SystemRow(item: item)
        case "feed_ref": FeedRefCard(item: item)
        case "role_suggestion": RoleSuggestionCard(item: item).modifier(MessageWidth(trailing: false))
        default: EmptyView()
        }
    }
}

/// Message width rule: max-w min(80%, 560px) (ui/ai/message.tsx:45).
private struct MessageWidth: ViewModifier {
    @Environment(\.chatAvailableWidth) private var availableWidth
    var trailing: Bool
    func body(content: Content) -> some View {
        content.frame(maxWidth: min(availableWidth > 0 ? availableWidth * 0.8 : 560, 560),
                      alignment: trailing ? .trailing : .leading)
            .frame(maxWidth: .infinity, alignment: trailing ? .trailing : .leading)
    }
}

// MARK: - Bubbles (UserMessage.tsx, AgentMessage.tsx, ui/ai/message.tsx)

struct UserBubble: View {
    @Environment(World.self) private var world
    @Environment(\.agentAccent) private var accent
    var item: Item
    var showAuthor: Bool

    var body: some View {
        let isSelf = item.authorId == world.selfId
        // A platform stranger is someone else in the room: an incoming (agent-side) bubble on the left, like a group chat.
        let stranger = item.channelSender?.role == "stranger"
        VStack(alignment: stranger ? .leading : .trailing, spacing: 8) {
            if stranger {
                Text(item.channelSender?.name.flatMap { $0.isEmpty ? nil : $0 } ?? "Someone").text(.xs, .medium).foregroundStyle(Theme.fgSubtle).padding(.leading, 2)
            } else if showAuthor && !isSelf {
                Text(world.member(item.authorId)?.name ?? "Teammate").text(.xs, .medium).foregroundStyle(Theme.fgSubtle).padding(.trailing, 2)
            }
            // Real attachments (server items carry them); `world.attachments` holds the names of files just picked.
            let files = (item.attachments ?? []).map { ($0.name, $0.kind == "image" ? "photo" : "doc") } + (world.attachments[item.id] ?? []).map { ($0, "paperclip") }
            if !files.isEmpty {
                HStack(spacing: 6) {
                    ForEach(files, id: \.0) { f, icon in
                        Label { Text(f).lineLimit(1) } icon: { Image(systemName: icon).font(.system(size: 12)) }
                            .text(.xs).foregroundStyle(Theme.fgMuted)
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .background(Theme.card, in: .rect(cornerRadius: Radius.md))
                            .overlay(RoundedRectangle(cornerRadius: Radius.md).stroke(Theme.border, lineWidth: 1))
                    }
                }
            }
            if let text = item.text, !text.isEmpty {
                HStack(alignment: .center, spacing: 6) {
                    // Which message didn't go out (the pill above the composer offers Retry / Delete).
                    if case .some(.some) = world.outbox[item.id] {
                        Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Theme.danger)
                            .accessibilityLabel("Not sent")
                    }
                    let ink = stranger ? Theme.bubbleAgentFg : (accent.map { onColor($0) } ?? Theme.bubbleUserFg)
                    let (quote, body) = Quote.split(text)
                    VStack(alignment: .leading, spacing: 6) {
                        if let quote { QuoteCard(text: quote, ink: ink) }
                        if !body.isEmpty { Text(body).text(.md) }
                    }
                        .foregroundStyle(ink)
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(stranger ? Theme.bubbleAgent : (accent ?? Theme.bubbleUser), in: .rect(cornerRadius: Radius.xxl))
                        .bubbleFrame()
                        .reactionChip(item.id, trailing: !stranger, agentEmoji: item.reaction)
                        .opacity(world.outbox[item.id] == .some(nil) ? 0.6 : 1)
                }
                // A message that did not go out offers Retry / Delete under it (they were in the old status strip).
                if case .some(.some) = world.outbox[item.id], let conversationId = item.conversationId {
                    HStack(spacing: 8) {
                        Button("Retry") { world.retry(item.id, in: conversationId) }
                        Button("Delete") { world.discard(item.id, in: conversationId) }
                    }
                    .buttonStyle(WebButton(variant: .ghost, size: .xs))
                }
                if let platform = ChannelPlatform(kind: item.source?.kind) {
                    ChannelMarker(text: "\(Fmt.time(item.at)) · via \(platform.name)", platform: platform).padding(stranger ? .leading : .trailing, 2)
                }
            }
        }
        .modifier(MessageWidth(trailing: !stranger))
    }
}

/// A source's site icon (Google's favicon service); a link glyph while it loads or when the site has none.
struct SourceFavicon: View {
    var url: String?
    var size: CGFloat = 16
    var body: some View {
        let host = url.flatMap(URL.init(string:))?.host
        RemoteImage(url: host.flatMap { URL(string: "https://www.google.com/s2/favicons?domain=\($0)&sz=64") }, maxSide: 32) { phase in
            if let image = phase.image { image.resizable().scaledToFill() }
            else { Image(systemName: "link").text(.xs).foregroundStyle(Theme.fgSubtle).frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.tile) }
        }
        .frame(width: size, height: size)
        .clipShape(.circle)
        .overlay(Circle().stroke(Theme.bubbleAgent, lineWidth: 1.5))
    }
}

/// "Sources" under a reply: up to three overlapping site icons, one fixed-height line; tapping lists every source.
struct SourcesPill: View {
    var citations: [Citation]
    @State private var open = false

    var body: some View {
        Button { open = true } label: {
            HStack(spacing: 6) {
                HStack(spacing: -5) {
                    ForEach(Array(citations.prefix(3).enumerated()), id: \.offset) { _, c in SourceFavicon(url: c.url) }
                }
                Text("Sources").text(.xs).foregroundStyle(Theme.fgMuted)
            }
            .frame(height: 24)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(citations.count) sources")
        .accessibilityIdentifier("sources-pill")
        .sheet(isPresented: $open) { SourcesSheet(citations: citations).junoSheetPresentation() }
    }
}

private struct SourcesSheet: View {
    var citations: [Citation]
    var body: some View {
        NavigationStack {
            List {
                ForEach(Array(citations.enumerated()), id: \.offset) { _, c in
                    if let url = c.url.flatMap(URL.init(string:)) {
                        Link(destination: url) {
                            HStack(spacing: 12) {
                                SourceFavicon(url: c.url, size: 28)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(c.title ?? url.host ?? c.url ?? "").text(.base, .medium).foregroundStyle(Theme.fg).lineLimit(2)
                                    Text(url.host ?? "").text(.xs).foregroundStyle(Theme.fgMuted).lineLimit(1)
                                }
                                Spacer(minLength: 0)
                            }
                        }
                    }
                }
            }
            .listStyle(.plain)
            .webGrouped()
            .pageHeader("Sources")
            .toolbar { CloseButton() }
        }
        .tint(Theme.fg)
    }
}

/// The tiny line under a message that crossed a messaging platform ("10:42 · via Slack", "Sent to Telegram").
struct ChannelMarker: View {
    var text: String
    var platform: ChannelPlatform

    var body: some View {
        HStack(spacing: 4) {
            ChannelBadge(platform: platform, size: 11)
            Text(text).text(.xs).foregroundStyle(Theme.fgSubtle)
        }
        .accessibilityElement(children: .combine)
    }
}

struct AgentBubble: View {
    @Environment(World.self) private var world
    var item: Item
    var showAuthor: Bool

    var body: some View {
        let agent = world.agent(item.agentId)
        VStack(alignment: .leading, spacing: 6) {
            if showAuthor {
                // The author (avatar and name) opens that agent's card, zooming out of this avatar.
                Button {
                    if let id = item.agentId { world.openAgentPage(id, from: "bubble-\(item.id)") }
                } label: {
                    HStack(spacing: 6) {
                        AvatarView(agent: agent, size: AvatarSize.author).agentZoomSource("bubble-\(item.id)")
                        Text(agent?.name ?? "Agent").text(.xs, .medium).foregroundStyle(Theme.fgMuted)
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(agent?.name ?? "Agent") card")
                .padding(.leading, 2)
            }
            // `markdown` is the lead-in, or the card's own text fallback when the agent said nothing else: then only the card shows.
            if showsBubble {
                VStack(alignment: .leading, spacing: 8) {
                    let (quote, body) = Quote.split(item.markdown ?? "")
                    if let quote { QuoteCard(text: quote, ink: Theme.bubbleAgentFg) }
                    AgentMarkdown(text: body)
                    // Only citations that link somewhere are sources (a memory citation has no page to open).
                    let sources = (item.citations ?? []).filter { $0.url.flatMap(URL.init(string:)) != nil }
                    if !sources.isEmpty, !ChatFeed.hidesSources(item, world: world) {
                        SourcesPill(citations: sources)
                    }
                }
                // The agent's grey bubble (as in Muse and the web).
                .foregroundStyle(Theme.bubbleAgentFg)
                .tint(Theme.bubbleAgentFg)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(Theme.bubbleAgent, in: .rect(cornerRadius: Radius.xxl))
                .bubbleFrame()
                .reactionChip(item.id, trailing: false)
                if let platform = ChannelPlatform(kind: item.replyTo?.kind) {
                    ChannelMarker(text: "Sent to \(platform.name)", platform: platform).padding(.leading, 2)
                }
            }
            if let ui = item.ui, ui.blocks.contains(where: { if case .replies = $0 { false } else { true } }) { UiMessageCard(doc: ui) }
            if world.repliesOpen(item), let ui = item.ui, case .replies(let options)? = ui.blocks.first(where: { if case .replies = $0 { true } else { false } }) {
                ReplyOptions(options: options) { text in if let c = item.conversationId { world.send(text, in: c) } }
            }
        }
        .modifier(MessageWidth(trailing: false))
    }

    private var showsBubble: Bool {
        guard let ui = item.ui else { return true }
        let said = (item.markdown ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return !said.isEmpty && said != ui.text?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func markdown(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }
}

/// Quick replies under the latest agent bubble: dashed full-width buttons (Meta Muse); a tap sends the label as my message.
struct ReplyOptions: View {
    var options: [String]
    var pick: (String) -> Void
    var body: some View {
        VStack(spacing: 8) {
            ForEach(options, id: \.self) { option in
                Button { pick(option) } label: {
                    Text(option).text(.md).foregroundStyle(Theme.fg).multilineTextAlignment(.leading)
                        .padding(.horizontal, 16).padding(.vertical, 12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .overlay(RoundedRectangle(cornerRadius: Radius.tile).strokeBorder(Theme.border, style: StrokeStyle(lineWidth: 1, dash: [5, 4])))
                        .contentShape(.rect(cornerRadius: Radius.tile))
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: 560)
    }
}

/// "Posted to Feed": a compact card for a post the agent put on the Feed; it opens that post over the tab bar (the Feed sits behind it).
struct FeedRefCard: View {
    @Environment(World.self) private var world
    var item: Item
    var body: some View {
        Button { world.feedFocus = item.feedPostId; world.tab = "feed"; world.postPage = item.feedPostId } label: {
            HStack(spacing: 12) {
                FeedImage(url: item.imageUrl.flatMap(URL.init(string:))) {
                    Image(systemName: "newspaper").text(.lg).foregroundStyle(Theme.fgSubtle)
                        .frame(width: 56, height: 56).background(Theme.tile, in: .rect(cornerRadius: 12))
                }
                .frame(width: 56, height: 56).clipShape(.rect(cornerRadius: 12))
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title ?? "Feed post").text(.base, .medium).foregroundStyle(Theme.fg).lineLimit(2).multilineTextAlignment(.leading)
                    if let summary = item.summary, !summary.isEmpty {
                        Text(summary).text(.sm).foregroundStyle(Theme.fg.opacity(0.7)).lineLimit(2).multilineTextAlignment(.leading)
                    }
                    Text("Posted to Feed").text(.sm).foregroundStyle(Theme.fgMuted)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").text(.sm, .semibold).foregroundStyle(Theme.fgSubtle)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.requestCard, in: .rect(cornerRadius: Radius.tile))
            .overlay(RoundedRectangle(cornerRadius: Radius.tile).strokeBorder(Theme.border, lineWidth: 0.5))
            .contentShape(.rect(cornerRadius: Radius.tile))
        }
        .buttonStyle(.plain)
        .frame(maxWidth: 560)
        .accessibilityIdentifier("feed-ref")
    }
}

/// The blocks an agent message carries, below the lead-in bubble: no surface of its own, so the grey tiles read as a stack of bubbles.
struct UiMessageCard: View {
    var doc: UiDoc
    var body: some View {
        UiDocView(doc: doc, showTitle: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(maxWidth: 560)
    }
}

// MARK: - Run: the failed/stopped row and the steps sheet

/// A task that failed or was stopped without a reply: one quiet line, like iMessage's "Not Delivered".
struct RunStatusRow: View {
    @Environment(World.self) private var world
    var run: Run

    var body: some View {
        let failed = run.status == "failed"
        HStack(spacing: 4) {
            Image(systemName: failed ? "exclamationmark.circle.fill" : "stop.circle").font(.system(size: 12))
            Text(failed ? "Failed" : "Stopped")
            if failed {
                Text("·")
                Button("Retry") { world.retryRun(run) }.buttonStyle(.plain).fontWeight(.semibold)
            }
            Spacer(minLength: 0)
        }
        .text(.xs).foregroundStyle(failed ? Theme.danger : Theme.fgMuted)
        .padding(.leading, 4).padding(.vertical, 2)
        .contentShape(.rect)
        .onTapGesture { if !failed { world.sheet = .runSteps(run.id) } }
        .accessibilityIdentifier(failed ? "run-failed" : "run-stopped")
    }
}

/// One step in plain words (see `stepLine`): a 20pt icon, one sentence, a muted domain. Tap for the URL, a short
/// excerpt and the screenshot. Shared by the task card,
/// the Activity sheet and the task thread.
/// The steps as one timeline: a thread joins their icons, so they read as one piece of work.
struct StepTimeline: View {
    var steps: [Step]
    /// Every step of the run (hidden ones too), for click labels taken from an earlier page snapshot.
    var run: [Step]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(steps.enumerated()), id: \.element.id) { i, step in
                StepRow(step: step, in: run, first: i == 0, last: i == steps.count - 1)
            }
        }
    }
}

struct StepRow: View {
    var step: Step
    var line: (text: String, domain: String?)
    /// Written after the run ends: a bold title and a muted line under it, instead of `line`.
    var title: String?
    var detail: String?
    var first: Bool
    var last: Bool
    @State private var open = false

    /// `run` is every step of the run, so a click can take its label from the page snapshot that came before it.
    init(step: Step, in run: [Step] = [], first: Bool = true, last: Bool = true) {
        self.step = step
        self.line = stepLine(step, in: run) ?? (StepText.humanize(step.target ?? "step"), nil)
        self.title = step.title?.isEmpty == false ? step.title : nil
        self.detail = step.detail?.isEmpty == false ? step.detail : nil
        self.first = first
        self.last = last
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            // The thread: into the icon from the row above, out of it to the row below (through an open detail too).
            VStack(spacing: 0) {
                thread.frame(height: 6).opacity(first ? 0 : 1)
                icon.frame(width: 24, height: 24).background(Theme.bgSubtle, in: .circle)
                thread.frame(maxHeight: .infinity).opacity(last ? 0 : 1)
            }
            .frame(width: 24)
            VStack(alignment: .leading, spacing: 0) {
                Button { withAnimation(.snappy(duration: 0.25)) { open.toggle() } } label: {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 1) {
                            if let title {
                                Text(title).text(.sm, .semibold).foregroundStyle(Theme.fg).lineLimit(2).multilineTextAlignment(.leading)
                                if let detail { Text(detail).text(.xs).foregroundStyle(Theme.fgMuted).lineLimit(3).multilineTextAlignment(.leading) }
                            } else {
                                Text(line.text).text(.sm).foregroundStyle(Theme.fg).lineLimit(2).multilineTextAlignment(.leading)
                            }
                            if title == nil, let domain = line.domain { Text(domain).text(.xs).foregroundStyle(Theme.fgSubtle).lineLimit(1) }
                        }
                        Spacer(minLength: 4)
                    }
                    .padding(.top, 8).padding(.bottom, 10)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                if open { StepDetail(step: step).padding(.bottom, 10) }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private var thread: some View { Rectangle().fill(Theme.border).frame(width: 1) }

    @ViewBuilder private var icon: some View {
        if step.status == "running" || step.status == "pending" {
            ProgressView().controlSize(.mini)
        } else {
            let failed = step.status == "failed" && !StepText.isRefusedPurchase(step)
            Image(systemName: failed ? "exclamationmark.circle" : stepSymbol(step) ?? "checkmark")
                .font(.system(size: 12)).foregroundStyle(failed ? Theme.danger : Theme.fgMuted)
        }
    }
}

/// What a step did, expanded: the page link, a readable excerpt, and the screenshot.
struct StepDetail: View {
    @Environment(World.self) private var world
    var step: Step
    @State private var image: UIImage?
    @State private var viewing = false

    var body: some View {
        let url = StepText.url(step)
        let excerpt = stepExcerpt(step)
        VStack(alignment: .leading, spacing: 8) {
            if let url, let link = URL(string: url) {
                Link(destination: link) { Text(url).text(.xs).lineLimit(2).multilineTextAlignment(.leading) }
            }
            if let excerpt { Text(excerpt).text(.sm).foregroundStyle(Theme.fgMuted) }
            if let image {
                Button { viewing = true } label: {
                    Image(uiImage: image).resizable().scaledToFit().frame(maxWidth: .infinity)
                        .clipShape(.rect(cornerRadius: Radius.lg))
                        .overlay(RoundedRectangle(cornerRadius: Radius.lg).stroke(Theme.border, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .sheet(isPresented: $viewing) { ImageViewer(image: image) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task { if let ref = step.screenshotRef { image = await world.previewImage(ref) } }
    }
}

/// Task thread (web RunView "full"): key facts, then every step.
struct RunDetailView: View {
    @Environment(World.self) private var world
    var runId: String

    var body: some View {
        let run = world.run(runId)
        let summary = run?.steps?.last { $0.output?.summary?.isEmpty == false }?.output?.summary
        Form {
            Section {
                HStack {
                    Text(run?.status == "completed" ? "Done" : Fmt.status(run?.status))
                        .text(.sm, .medium)
                        .foregroundStyle(run?.status == "completed" ? Theme.success : Theme.fg)
                        .padding(.horizontal, 10).padding(.vertical, 3)
                        .background((run?.status == "completed" ? Theme.success : Theme.muted).opacity(run?.status == "completed" ? 0.15 : 1), in: .capsule)
                    Spacer()
                    if let title = run?.title { Text(title).text(.sm).foregroundStyle(Theme.fgMuted).lineLimit(2) }
                }
                if let summary { Text(summary).text(.base).foregroundStyle(Theme.fg) }
            } header: { Text("Summary") }
            Section {
                info("Agent", world.agent(run?.agentId)?.name)
                info("Trigger", run?.triggerLabel ?? run?.kind?.capitalized)
                info("Started", run?.startedAt.map { Fmt.ago($0) })
                info("Duration", run?.durationMs.map { Fmt.duration($0) })
                info("Cost", run?.usage?.costUsd.map { String(format: "$%.2f", $0) })
            }
            Section("Steps") { ForEach(visibleSteps(run?.steps ?? [])) { StepRow(step: $0, in: run?.steps ?? []).listRowInsets(.init(top: 0, leading: 16, bottom: 0, trailing: 16)) } }
            if let error = run?.error {
                Section {
                    Text(Fmt.runError(error)).foregroundStyle(Theme.danger)
                    Text(error).text(.xs).foregroundStyle(Theme.fgSubtle).textSelection(.enabled)
                    if isModelSetupError(error) { OpenModelSettingsButton(title: "Open model settings") }
                }
            }
        }
        .webGrouped().listRowBackground(Theme.muted)
        .pageHeader(world.taskTitle(for: run) ?? "Activity")
        .task { world.loadSteps(runId) }
    }
}

// MARK: - Plan (PlanCard.tsx)

struct PlanCard: View {
    var title: String
    var todos: [Todo]
    // Local: the row's own height change reaches the list through the cell's onGeometryChange, which re-measures it.
    @State private var expanded = false
    private static let runningRows = 3

    var body: some View {
        let done = todos.filter { $0.status == "done" }.count
        let allDone = !todos.isEmpty && done == todos.count
        let active = todos.filter { $0.status == "in_progress" || $0.status == "blocked" }
        let pending = todos.filter { $0.status == "pending" }
        let preview = Array((active + pending).prefix(Self.runningRows))
        let rows = expanded ? todos : (allDone ? [] : preview)
        let hidden = todos.count - preview.count
        VStack(alignment: .leading, spacing: 0) {
            Button { if allDone { expanded.toggle() } } label: {
                HStack(spacing: 12) {
                    Text(title).text(.sm, .medium).foregroundStyle(Theme.fg)
                    Spacer()
                    if allDone {
                        HStack(spacing: 4) {
                            Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(Theme.success)
                            Text("Done").text(.xs).foregroundStyle(Theme.fgSubtle)
                            Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.fgSubtle)
                                .rotationEffect(.degrees(expanded ? 180 : 0))
                        }
                    } else {
                        Text("\(todos.count - done) remaining").text(.xs).foregroundStyle(Theme.fgSubtle)
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(!allDone)
            ForEach(rows, id: \.id) { todo in
                Divider().overlay(Theme.border)
                TodoRow(todo: todo).padding(.horizontal, 12).padding(.vertical, 8)
            }
            if !allDone, hidden > 0 {
                Divider().overlay(Theme.border)
                Button { withAnimation(.snappy(duration: 0.2)) { expanded.toggle() } } label: {
                    Text(expanded ? "Show less" : "\(hidden) more").text(.xs).foregroundStyle(Theme.fgMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
            }
            GeometryReader { g in
                Rectangle().fill(Theme.bgSubtle)
                    .overlay(alignment: .leading) { Rectangle().fill(Theme.fgSubtle).frame(width: g.size.width * CGFloat(done) / CGFloat(max(todos.count, 1))) }
            }
            .frame(height: 2)
        }
        .background(Theme.card, in: .rect(cornerRadius: Radius.xl))
        .clipShape(.rect(cornerRadius: Radius.xl))
        .overlay(RoundedRectangle(cornerRadius: Radius.xl).stroke(Theme.border, lineWidth: 1))
        .onChange(of: allDone) { _, now in if !now { expanded = false } }
    }
}

struct TodoRow: View {
    var todo: Todo
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            mark.frame(width: 16, height: 16)
                .overlay(RoundedRectangle(cornerRadius: Radius.sm / 2).stroke(Theme.border, lineWidth: todo.status == "pending" ? 1 : 0))
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                Text(todo.text ?? "").text(.sm)
                    .foregroundStyle(todo.status == "done" ? Theme.fgMuted : Theme.fg)
                    .strikethrough(todo.status == "done")
                if let note = todo.note { Text(note).text(.xs).foregroundStyle(Theme.fgMuted) }
            }
        }
    }

    @ViewBuilder private var mark: some View {
        switch todo.status {
        case "done": Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(Theme.success)
        case "in_progress": ProgressView().controlSize(.mini)
        case "blocked": Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 10)).foregroundStyle(Theme.warning)
        default: Color.clear
        }
    }
}

// MARK: - Request cards live in RequestCards.swift

/// The Needs-you queue's detail (pane/ApprovalQueue.tsx:76-130): title, summary, Action/To/Why,
/// Deny/Allow for approvals only, and "Open in chat" / "Answer in chat".
struct RequestDetail: View {
    @Environment(World.self) private var world
    var requestId: String

    var body: some View {
        let r = world.request(requestId)
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let r { RequestCard(request: r) }
                if let c = r?.conversationId {
                    Button("Open in chat") { world.openChat(c) }.buttonStyle(WebButton(variant: .ghost, size: .regular))
                }
            }
            .padding(16)
        }
        .background(Theme.canvas)
        .pageHeader(Fmt.requestTitle(r?.kind))
    }
}

// MARK: - File type lines (the viewer, the cards and the Files rows share them; web: fileTypeLine in chat-files)

/// "MARKDOWN · 6 KB": the kind of file, then its size.
func fileTypeLine(_ file: LibraryItem) -> String {
    let ext = ((file.name ?? "") as NSString).pathExtension.lowercased()
    let type: String?
    switch ext {
    case "md", "markdown": type = "Markdown"
    case "txt": type = "Text"
    case "": type = file.mimeType.flatMap { $0.split(separator: "/").last.map(String.init) } ?? file.kind
    default: type = ext
    }
    return [type?.uppercased(), Fmt.bytes(file.sizeBytes)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
}

@MainActor func fileMeta(_ file: LibraryItem, _ world: World) -> String {
    [fileTypeLine(file), world.agent(file.createdByAgentId)?.name ?? "You"].filter { !$0.isEmpty }.joined(separator: " · ")
}

/// A row in a files list (the computer's Files): a picture tile, the name, "MARKDOWN · 6 KB · Juno". Tap opens the viewer.
struct FileRow: View {
    @Environment(World.self) private var world
    var file: LibraryItem
    @State private var viewing = false

    var body: some View {
        HStack(spacing: 12) {
            ArtifactThumbnail(file: file, symbol: .lg)
                .frame(width: 44, height: 44)
                .clipShape(.rect(cornerRadius: Radius.lg))
            VStack(alignment: .leading, spacing: 2) {
                Text(file.name ?? "").text(.base, .medium).foregroundStyle(Theme.fg).lineLimit(1)
                Text(fileMeta(file, world)).text(.xs).foregroundStyle(Theme.fgSubtle)
            }
            Spacer(minLength: 0)
            if file.pinned == true { Image(systemName: "pin.fill").font(.system(size: 10)).foregroundStyle(Theme.fgSubtle) }
        }
        .contentShape(.rect)
        .tapOnly { viewing = true }
        .accessibilityIdentifier("file-\(file.id)")
        .fullScreenCover(isPresented: $viewing) { ArtifactViewer(file: file) }
    }
}

func icon(_ file: LibraryItem) -> String {
    switch file.render {
    case "html": return "macwindow"
    case "app": return "square.grid.2x2"
    case "video": return "film"
    case "doc": return "doc.text"
    default: break
    }
    return switch file.kind {
    case "image": "photo"
    case "spreadsheet": "tablecells"
    case "code": "chevron.left.forwardslash.chevron.right"
    case "pdf": "doc.richtext"
    default: "doc.text"
    }
}

// MARK: - Routine, handoff, system (RoutineItem.tsx, HandoffMarker.tsx, SystemRow.tsx)

struct RoutineRow: View {
    var routine: Routine
    var change: String?
    var body: some View {
        RouteLink(route: .page(.routines)) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "arrow.triangle.2.circlepath").font(.system(size: 12)).foregroundStyle(Theme.fgMuted)
                    .frame(width: 24, height: 24).background(Theme.bgSubtle, in: .rect(cornerRadius: Radius.sm))
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(routine.name ?? "").text(.sm, .medium).foregroundStyle(Theme.fg).lineLimit(1)
                        Spacer(minLength: 4)
                        Text("\(change == "updated" ? "Routine updated" : "Routine created") · \(routine.status?.capitalized ?? "")")
                            .text(.xs).foregroundStyle(Theme.fgMuted).lineLimit(1)
                    }
                    Text(routine.trigger?.human ?? "").text(.xs).foregroundStyle(Theme.fgMuted)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(Theme.card, in: .rect(cornerRadius: Radius.xl))
            .overlay(RoundedRectangle(cornerRadius: Radius.xl).stroke(Theme.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

/// "Juno handed off to Iris": a centred system line.
struct HandoffMarker: View {
    @Environment(World.self) private var world
    var item: Item
    var body: some View {
        Text(label)
            .text(.xs).foregroundStyle(Theme.fgMuted)
            .multilineTextAlignment(.center).lineLimit(2)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
    }
    private var label: String {
        let from = world.agent(item.agentId)?.name ?? world.conversation(item.conversationId)?.agentIds?.first.flatMap { world.agent($0)?.name } ?? "An agent"
        let to = world.agent(item.toAgentId)?.name ?? "another agent"
        return "\(from) handed off to \(to)"
    }
}

struct SystemRow: View {
    @Environment(World.self) private var world
    var item: Item

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: item.level == "error" ? "xmark.circle" : item.level == "warning" ? "exclamationmark.triangle" : "info.circle")
                .font(.system(size: 12))
                .foregroundStyle(item.level == "error" ? Theme.danger : item.level == "warning" ? Theme.warning : Theme.fgMuted)
            Text(item.text ?? "")
            Spacer(minLength: 4)
            if let action = item.action {
                Button {
                    if action.command == "computer.open",
                       let agentId = world.conversation(item.conversationId)?.agentIds?.first,
                       let c = item.conversationId {
                        world.sheet = .workspace(conversationId: c, agentId: agentId)
                    }
                } label: {
                    Label(action.command == "run.retry" ? "Retry" : action.label ?? "Open",
                          systemImage: action.command == "computer.open" ? "play.display" : "arrow.counterclockwise")
                        .labelStyle(.titleAndIcon)
                }
                .buttonStyle(WebButton(variant: .ghost, size: .xs))
            }
        }
        .text(.xs).foregroundStyle(Theme.fgMuted)
        .padding(.vertical, 6)
    }
}

// MARK: - Bubble frame

/// Reports where the bubble sits in its row (the cell's context-menu preview lifts only this rect).
private struct BubbleFrame: ViewModifier {
    @Environment(\.reportBubbleFrame) private var report

    func body(content: Content) -> some View {
        content.onGeometryChange(for: CGRect.self) { $0.frame(in: .named("chatRow")) } action: { report?($0) }
    }
}

extension View {
    func bubbleFrame() -> some View { modifier(BubbleFrame()) }
}

// MARK: - Reactions

/// The emoji a long-press offers (the menu's palette row).
let reactionChoices = ["👍", "❤️", "😂", "😮", "😢", "🙏"]

/// My reaction as a chip on the bubble's bottom corner; tap it to take it back. The room it needs is part of the
/// row, so the cell measures taller when one is added (the list reconfigures the row on react).
private struct ReactionChip: ViewModifier {
    @Environment(World.self) private var world
    var itemId: String
    var trailing: Bool
    var agentEmoji: String?

    func body(content: Content) -> some View {
        let own = world.reactions[itemId]
        let mine = own ?? agentEmoji
        content
            .overlay(alignment: trailing ? .bottomLeading : .bottomTrailing) {
                if let mine {
                    Text(mine).font(.system(size: 14))
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Theme.card, in: .capsule)
                        .overlay(Capsule().strokeBorder(Theme.border))
                        .offset(x: trailing ? -6 : 6, y: 14)
                        .onTapGesture { if own != nil { world.react(itemId, nil) } }
                        .accessibilityLabel(own != nil ? "Your reaction \(mine). Tap to remove." : "Reaction \(mine)")
                }
            }
            .padding(.bottom, mine == nil ? 0 : 14)
    }
}

extension View {
    func reactionChip(_ itemId: String, trailing: Bool, agentEmoji: String? = nil) -> some View {
        modifier(ReactionChip(itemId: itemId, trailing: trailing, agentEmoji: agentEmoji))
    }
}
