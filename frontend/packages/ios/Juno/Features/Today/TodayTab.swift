import SwiftUI

/// Today, the first tab (owner-approved 2026-10-26, look restored 2026-10-27): the Aurora wash and a big greeting, the agents
/// as stories (the ring is lit in the agent's tint while it works), then four blocks, each capped at three with "All ›" on
/// its header row. Needs you: pending requests, each with its own actions and "Open chat". Progress: what the agents did
/// and are doing, and the goals card. Updates: the brief and the newest Feed posts. Ideas: the old "For you" carousel of
/// suggestion cards, Try or Never. A block with nothing to say is not shown.
struct TodayTab: View {
    @Environment(World.self) private var world
    @Environment(\.colorScheme) private var scheme

    /// Rows per block before "All".
    private static let limit = 3

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                hero
                VStack(alignment: .leading, spacing: 24) {
                    needsYou
                    progress
                    updates
                }
                .padding(.horizontal, 16)
                ideas
            }
            .padding(.bottom, 24)
        }
        .background(Theme.canvas)
    }

    // MARK: Hero

    /// The greeting by the owner's clock and the agents as stories, over the glow (it reaches up under the bar).
    private var hero: some View {
        let name = (world.session?.name ?? "").split(separator: " ").first.map(String.init) ?? ""
        return VStack(alignment: .leading, spacing: 10) {
            Text(world.greeting(name: name))
                .text(.xxl, .bold).foregroundStyle(Theme.fg).lineLimit(1)
                .accessibilityAddTraits(.isHeader)
            if !world.agents.isEmpty { AgentStories(working: Set(world.today.working.map(\.agentId))) }
        }
        .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            // As the original home placed it: 260pt tall and centred on the hero, so it reaches about 70pt above the greeting (up
            // under the status bar) and the bright part of the wash sits right behind it. (Pushed 120pt up it left only the faded
            // bottom half in view.)
            AuroraBackground(colors: Theme.glow, height: 260)
                .opacity(scheme == .dark ? 0.7 : 0.9)
                .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.3), .init(color: .black, location: 1)],
                                     startPoint: .top, endPoint: .bottom))
        }
    }

    // MARK: Needs you

    @ViewBuilder private var needsYou: some View {
        let pending = world.needsYou
        if !pending.isEmpty {
            TodayBlock("Needs you", all: { world.sheet = .queue }) {
                ForEach(pending.prefix(Self.limit)) { request in
                    VStack(alignment: .leading, spacing: 6) {
                        RequestCard(request: request, compact: true)
                        if let conversationId = request.conversationId {
                            Button { world.openChat(conversationId) } label: {
                                Text("Open chat").text(.sm, .medium).foregroundStyle(Theme.fg)
                            }
                            .buttonStyle(.plain)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                        }
                    }
                }
            }
        }
    }

    // MARK: Progress

    @ViewBuilder private var progress: some View {
        let items = progressItems
        let goals = world.goals
        if !items.isEmpty || !goals.isEmpty {
            TodayBlock("Progress", route: .goalList) {
                if !items.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                            if index > 0 { Divider().padding(.leading, 48) }
                            progressRow(item)
                        }
                    }
                    .background(Theme.muted.opacity(0.7), in: .rect(cornerRadius: Radius.xl))
                }
                if !goals.isEmpty {
                    RouteLink(route: .goalList) {
                        HStack(spacing: 12) {
                            Image(systemName: "target").foregroundStyle(Theme.fgMuted)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Goals").text(.sm, .semibold).foregroundStyle(Theme.fgMuted)
                                Text(goalsLine(goals)).text(.md).foregroundStyle(Theme.fg)
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right").foregroundStyle(Theme.fgSubtle)
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.muted.opacity(0.7), in: .rect(cornerRadius: Radius.xl))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func progressRow(_ item: ProgressItem) -> some View {
        HStack(spacing: 10) {
            AvatarView(agent: world.agent(item.agentId), size: AvatarSize.md)
            Text(item.done ? "\(world.agent(item.agentId)?.name ?? "Agent") finished: \(item.title)" : "\(world.agent(item.agentId)?.name ?? "Agent"): \(item.title)")
                .text(.base).foregroundStyle(Theme.fg).lineLimit(1)
            Spacer(minLength: 0)
            if item.done {
                Image(systemName: "checkmark.circle.fill").text(.lg).foregroundStyle(Theme.success)
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .tapOnly { open(item) }
        .accessibilityIdentifier("today-progress-\(item.id)")
    }

    private func open(_ item: ProgressItem) {
        if item.done, let done = world.today.completed.first(where: { $0.runId == item.id }) { world.open(done); return }
        if let chat = world.run(item.id)?.conversationId ?? world.directConversation(for: item.agentId)?.id { world.openChat(chat) }
        else { world.openAgentPage(item.agentId, from: "today-\(item.id)") }
    }

    /// Working runs first, then what just finished; three at most.
    private var progressItems: [ProgressItem] {
        let today = world.today
        let working = today.working.map { ProgressItem(id: $0.runId, agentId: $0.agentId, title: $0.title, done: false) }
        let completed = today.completed.map { ProgressItem(id: $0.runId, agentId: $0.agentId, title: $0.title, done: true) }
        return Array((working + completed).prefix(Self.limit))
    }

    private func goalsLine(_ goals: [PlannedGoal]) -> String {
        let active = goals.filter { $0.status == "active" }.count
        let done = goals.filter { $0.status == "done" }.count
        return "\(active) active · \(done) done"
    }

    // MARK: Updates

    @ViewBuilder private var updates: some View {
        let today = world.today
        let posts = Array(world.feed.prefix(Self.limit))
        if today.brief != nil || !posts.isEmpty {
            TodayBlock("Updates", route: .feed) {
                if let brief = today.brief { BriefCard(brief: brief) }
                ForEach(posts) { post in
                    FeedRow(post: post) { world.postPage = post.id }
                }
            }
        }
    }

    // MARK: Ideas

    /// The open ideas, then the server's suggestions, three cards at most, in the old "For you" carousel.
    @ViewBuilder private var ideas: some View {
        let cards = ideaCards
        if !cards.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                BlockHeader(title: "Ideas", route: .ideas).padding(.horizontal, 16)
                ScrollView(.horizontal) {
                    HStack(alignment: .top, spacing: 12) {
                        ForEach(cards) { card in
                            card.tile
                                .containerRelativeFrame(.horizontal) { width, _ in cards.count == 1 ? width - 32 : width * 0.85 }
                        }
                    }
                    .scrollTargetLayout()
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.vertical, 6)
                }
                .scrollTargetBehavior(.viewAligned)
                .contentMargins(.horizontal, 16, for: .scrollContent)
                .scrollIndicators(.hidden)
            }
        }
    }

    private var ideaCards: [IdeaCard] {
        let open = world.ideas.map(IdeaCard.idea)
        let suggestions = world.today.inspiration.map(IdeaCard.suggestion)
        return Array((open + suggestions).prefix(Self.limit))
    }
}

/// One card of the Ideas carousel: an idea (Try or Never) or one of the server's suggestions (its own button).
private enum IdeaCard: Identifiable {
    case idea(PlannedIdea)
    case suggestion(TodaySummary.Inspiration)

    var id: String {
        switch self {
        case .idea(let idea): "idea-\(idea.id)"
        case .suggestion(let card): "suggestion-\(card.id)"
        }
    }

    @ViewBuilder var tile: some View {
        switch self {
        case .idea(let idea): IdeaTile(idea: idea)
        case .suggestion(let card): InspirationRow(card: card, fillsHeight: true)
        }
    }
}

/// An idea as a suggestion card: the agent's character, the idea, "agent · why", Never (quiet) and Try (black capsule).
private struct IdeaTile: View {
    @Environment(World.self) private var world
    var idea: PlannedIdea

    var body: some View {
        let agent = world.agent(idea.agentId)
        let text = idea.text ?? idea.prompt ?? ""
        let subtitle = [agent?.name, idea.why].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " \u{00B7} ")
        SuggestionCard(
            title: text,
            subtitle: subtitle,
            buttons: [CardButton(label: "Never", kind: .link) { withAnimation { world.ideaFeedback(idea.id, "never", scope: "topic") } },
                      CardButton(label: "Try") { world.acceptIdea(idea) }],
            fillsHeight: true
        ) {
            AvatarView(agent: agent, size: AvatarSize.md)
        }
        .accessibilityIdentifier("today-idea-\(idea.id)")
    }
}

/// A block's header row: the title at the left, "All ›" at the right (it opens the full list).
private struct BlockHeader: View {
    var title: String
    var all: (() -> Void)?
    var route: Route?

    var body: some View {
        HStack {
            Text(title).text(.lg, .semibold).foregroundStyle(Theme.fg)
            Spacer(minLength: 0)
            if let route {
                RouteLink(route: route) { allLabel }.buttonStyle(.plain)
            } else if let all {
                Button(action: all) { allLabel }.buttonStyle(.plain)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var allLabel: some View {
        HStack(spacing: 2) { Text("All"); Image(systemName: "chevron.right").text(.xs, .semibold) }
            .text(.sm).foregroundStyle(Theme.fgMuted)
            .frame(height: 32)
            .contentShape(.rect)
            .accessibilityLabel("All \(title)")
    }
}

/// A Today block: its header row, then the rows (at most three, the caller caps them).
private struct TodayBlock<Content: View>: View {
    var title: String
    var all: (() -> Void)?
    var route: Route?
    @ViewBuilder var content: Content

    init(_ title: String, all: @escaping () -> Void, @ViewBuilder content: () -> Content) {
        self.title = title; self.all = all; self.content = content()
    }

    init(_ title: String, route: Route, @ViewBuilder content: () -> Content) {
        self.title = title; self.route = route; self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            BlockHeader(title: title, all: all, route: route)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One row of Progress: a run that is working or has just finished.
private struct ProgressItem: Identifiable {
    var id: String
    var agentId: String
    var title: String
    var done: Bool
}

// MARK: - Stories

/// Avatars in a row like stories; the ring turns in the agent's tint while it has an active run. A tap opens the agent card.
private struct AgentStories: View {
    @Environment(World.self) private var world
    var working: Set<String>
    private static let limit = 20

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 12) {
                ForEach(world.agents.prefix(Self.limit)) { agent in
                    VStack(spacing: 4) {
                        StoryRing(active: working.contains(agent.id), tint: agentTint(agent)) {
                            AvatarView(agent: agent, size: 44)
                        }
                        Text(agent.name ?? "").text(.xs).foregroundStyle(Theme.fgMuted).lineLimit(1).frame(width: 56)
                    }
                    .agentZoomSource("today-\(agent.id)")
                    .tapOnly { world.openAgentPage(agent.id, from: "today-\(agent.id)") }
                    .accessibilityIdentifier("today-agent-\(agent.id)")
                }
                VStack(spacing: 4) {
                    Image(systemName: "plus").text(.xl, .medium).foregroundStyle(Theme.fgMuted)
                        .frame(width: 52, height: 52)
                        .background(Theme.muted, in: .circle)
                    Text("New").text(.xs).foregroundStyle(Theme.fgMuted).frame(width: 56)
                }
                .tapOnly { world.sheet = .newAgent }
                .accessibilityLabel("New agent")
                .accessibilityIdentifier("today-new-agent")
            }
            .padding(.vertical, 2)
        }
        .scrollClipDisabled()
        .padding(.horizontal, -16)
        .contentMargins(.horizontal, 16, for: .scrollContent)
    }
}

/// A 52pt slot for an avatar: a thin ring when idle, an arc that turns in the agent's tint while it works.
private struct StoryRing<Content: View>: View {
    var active: Bool
    var tint: Color
    @ViewBuilder var content: Content
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        content
            .frame(width: 52, height: 52)
            .overlay {
                if active {
                    TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { timeline in
                        let angle = reduceMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.2) / 1.2 * 360
                        Circle().trim(from: 0, to: 0.7).stroke(tint, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                            .rotationEffect(.degrees(angle))
                    }
                } else {
                    Circle().stroke(Theme.border, lineWidth: 1)
                }
            }
    }
}

// MARK: - Brief

/// "Today's brief · 8:00": the summary beside the first post's picture; a tap opens the Feed.
private struct BriefCard: View {
    @Environment(World.self) private var world
    var brief: TodaySummary.Brief

    var body: some View {
        let post = brief.postIds.first.flatMap { id in world.feed.first { $0.id == id } }
        RouteLink(route: .feed) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Label("Today's brief · \(brief.at.formatted(.dateTime.hour().minute()))", systemImage: "newspaper")
                        .text(.sm, .semibold).foregroundStyle(Theme.fgMuted)
                    Text(brief.summary).text(.md, .semibold).foregroundStyle(Theme.fg).lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: 0)
                if let url = post?.imageUrl.flatMap(URL.init(string:)) {
                    FeedImage(url: url) { EmptyView() }
                        .frame(width: 64, height: 64).clipShape(.rect(cornerRadius: Radius.md))
                }
                Image(systemName: "chevron.right").text(.xs, .semibold).foregroundStyle(Theme.fgSubtle)
            }
            .padding(12)
            .background(Theme.muted.opacity(0.7), in: .rect(cornerRadius: Radius.xl))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("today-brief")
    }
}

/// "Show more" / "All · N" under a capped list.
struct ShowMoreButton: View {
    var title: String
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title).text(.sm, .medium).foregroundStyle(Theme.fg)
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}
