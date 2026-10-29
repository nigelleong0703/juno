import SwiftUI

/// Team, the third tab (owner-approved 2026-10-26, "No boxes"): Agents · People · Memory under the segmented control. Agents
/// and Memory sit under the aurora wash. Agents: each agent open on the page, no card (TeamAgents); "+" in the bar starts a new
/// one. People and Memory are in TeamPeopleView and TeamMemoryView (Memory's search is the bar's magnifier). The tab is one
/// native list; the segments and the heading are its first rows.
struct TeamTab: View {
    @Environment(World.self) private var world
    @State private var segment = Segment.agents
    @State private var fact: FactPick?

    enum Segment: String, CaseIterable, Identifiable {
        case agents = "Agents", people = "People", memory = "Memory"
        var id: String { rawValue }
    }

    var body: some View {
        List {
            Picker("Team sections", selection: $segment) {
                ForEach(Segment.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .teamRow(separator: false)
            switch segment {
            case .agents: TeamAgents()
            case .people:
                TeamHeading(title: "People", subtitle: "Who your team talks to")
                TeamPeople()
            case .memory: TeamMemory()
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background {
            ZStack(alignment: .top) {
                Theme.canvas
                if segment != .people { TeamWash() }
            }
            .ignoresSafeArea()
        }
        .environment(\.openFact) { fact = FactPick(id: $0) }
        .memoryFactSheet($fact)
        .toolbar {
            if segment == .agents {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("New agent", systemImage: "plus") { world.sheet = .newAgent }.accessibilityIdentifier("team-new-agent")
                }
            }
            if segment == .memory {
                ToolbarItem(placement: .topBarTrailing) {
                    RouteLink(route: .memorySearch) { Image(systemName: "magnifyingglass") }
                        .accessibilityLabel("Search memory")
                        .accessibilityIdentifier("memory-search")
                }
            }
        }
        .task(id: segment) {
            switch segment {
            case .agents: break
            case .people: await world.teamPeople.reload(world)
            case .memory:
                await world.teamMemory.reload(world)
                await world.teamPeople.reload(world)
            }
        }
    }
}

extension View {
    /// A Team list row: 16pt at the sides, no rule unless asked (cards and headers), the canvas behind it.
    func teamRow(separator: Bool = true, vertical: CGFloat = 5) -> some View {
        listRowInsets(EdgeInsets(top: vertical, leading: 16, bottom: vertical, trailing: 16))
            .listRowSeparator(separator ? .automatic : .hidden)
            .listRowBackground(Color.clear)
    }
}

/// The aurora wash behind the Agents and Memory headers (Today's glow).
private struct TeamWash: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        AuroraBackground(colors: Theme.glow, height: 300)
            .opacity(scheme == .dark ? 0.6 : 0.85)
            .allowsHitTesting(false)
    }
}

/// A Team segment's page heading: the title large and one muted line under it ("Your team" with how many are working,
/// "People" with who the team talks to).
private struct TeamHeading: View {
    var title: String
    var subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.system(size: 30, weight: .bold)).foregroundStyle(Theme.fg).accessibilityAddTraits(.isHeader)
            Text(subtitle).text(.md).foregroundStyle(Theme.fgMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .teamRow(separator: false, vertical: 8)
    }
}

/// Every agent, ten at a time, open on the page with no card: the character large on a soft radial glow of its own tint, the
/// name large and the role muted (only a real one), one doing line in the agent's words with a live dot (green while it works,
/// grey when it is free) and a small goal-progress line while it has active goals. Above them the title and a status line.
private struct TeamAgents: View {
    @Environment(World.self) private var world
    @State private var limit = 10

    var body: some View {
        let agents = world.agents
        TeamHeading(title: "Your team", subtitle: statusLine(agents))
        ForEach(agents.prefix(limit)) { agent in
            Button { world.openAgentPage(agent.id, from: "team-\(agent.id)") } label: { TeamAgentRow(agent: agent) }
                .buttonStyle(.plain)
                .accessibilityIdentifier("team-agent-\(agent.id)")
                .teamRow(separator: false, vertical: 3)
        }
        if agents.count > limit {
            ShowMoreButton(title: "Show more") { limit += 10 }.teamRow(separator: false)
        }
    }

    /// "2 working now · 2 goals in progress".
    private func statusLine(_ agents: [Agent]) -> String {
        let working = agents.filter { world.isWorking($0.id) || $0.status == "working" }.count
        let goals = world.goals.filter { $0.status == "active" }.count
        var parts = [working > 0 ? "\(working) working now" : "Nobody is working right now"]
        if goals > 0 { parts.append(goals == 1 ? "1 goal in progress" : "\(goals) goals in progress") }
        return parts.joined(separator: " \u{00B7} ")
    }
}

private struct TeamAgentRow: View {
    @Environment(World.self) private var world
    var agent: Agent

    /// The cap height of the doing line's font (`.text(.md)`, a fixed 15pt system font), for the live dot's alignment.
    private static let doingCapHeight = UIFont.systemFont(ofSize: TextSize.md.size).capHeight

    var body: some View {
        let tint = agentTint(agent)
        let live = world.isWorking(agent.id) || agent.status == "working"
        HStack(spacing: 16) {
            AvatarView(agent: agent, size: 70)
                .frame(width: 84, height: 84)
                .background {
                    Circle()
                        .fill(RadialGradient(colors: [tint.opacity(0.75), tint.opacity(0)], center: .center, startRadius: 0, endRadius: 45))
                        .frame(width: 96, height: 96)
                }
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(agent.name ?? "").font(.system(size: 21, weight: .bold)).foregroundStyle(Theme.fg).lineLimit(1)
                    if let role = world.role(agent) {
                        Text(role).text(.base).foregroundStyle(Theme.fgSubtle).lineLimit(1)
                    }
                }
                // The 8pt dot is centred on the first line's cap height, not on the whole block, so it stays on line one
                // when the text wraps to a second line: the dot's first-baseline guide sits half a cap height plus half
                // the dot below its top, which puts its centre half a cap height above the text's first baseline.
                let cap = Self.doingCapHeight
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Circle().fill(live ? Theme.success : Theme.fgSubtle.opacity(0.5)).frame(width: 8, height: 8)
                        .alignmentGuide(.firstTextBaseline) { _ in cap / 2 + 4 }
                    Text(world.doingLine(agent)).text(.md).foregroundStyle(Theme.fgMuted).lineLimit(2)
                }
                if let goal = goalLine {
                    Text(goal).text(.sm).foregroundStyle(Theme.fgSubtle).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
    }

    /// The agent's one active goal with the plan's progress ("Build muscle · 2/5 milestones"), or how many it has.
    private var goalLine: String? {
        let goals = world.goals.filter { $0.agentId == agent.id && $0.status == "active" }
        guard let only = goals.first else { return nil }
        if goals.count > 1 { return "\(goals.count) goals in progress" }
        let plan = only.milestones ?? []
        let progress = plan.isEmpty ? nil : "\(plan.filter { $0.status == "done" }.count)/\(plan.count) milestones"
        return [only.title, progress].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " \u{00B7} ")
    }
}

/// One Team list in its states: loading, not shipped yet ("Coming soon"), unavailable right now (a quiet line), failed,
/// empty or the rows (list rows of the Team tab's list). `offlineText` is what a 503 says.
struct TeamListView<Item, Rows: View>: View {
    var load: TeamLoad<Item>
    var emptyTitle: String
    /// Shown quietly when the route answers 503 (not an error screen).
    var offlineText: String
    @ViewBuilder var rows: ([Item]) -> Rows

    var body: some View {
        switch load {
        case .loading:
            ProgressView().frame(maxWidth: .infinity).padding(.top, 24).teamRow(separator: false)
        case .unavailable:
            VStack(alignment: .leading, spacing: 4) {
                Text("Coming soon").text(.md, .semibold).foregroundStyle(Theme.fg)
                Text("People and memory arrive in a coming update.").text(.sm).foregroundStyle(Theme.fgMuted)
            }
            .teamRow(separator: false)
        case .offline:
            Text(offlineText).text(.sm).foregroundStyle(Theme.fgMuted).teamRow(separator: false)
        case .failed:
            Text("Something went wrong").text(.sm).foregroundStyle(Theme.fgMuted).teamRow(separator: false)
        case .loaded(let items):
            if items.isEmpty {
                Text(emptyTitle).text(.sm).foregroundStyle(Theme.fgMuted).teamRow(separator: false)
            } else {
                rows(items)
            }
        }
    }
}

/// A search field in the web's input look (a solid fill and a border, no glass).
struct TeamSearchField: View {
    @Binding var text: String
    var prompt: String
    /// Focus the field when it appears (a screen made for searching).
    var autofocus = false
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(Theme.fgSubtle)
            TextField(prompt, text: $text).text(.md).foregroundStyle(Theme.fg).autocorrectionDisabled()
                .focused($focused)
                .onAppear { if autofocus { focused = true } }
            if !text.isEmpty {
                Button { text = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.fgSubtle) }
                    .buttonStyle(.plain).accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 12).frame(height: 40)
        .background(Theme.inputBg, in: .rect(cornerRadius: Radius.lg))
        .overlay(RoundedRectangle(cornerRadius: Radius.lg).stroke(Theme.border, lineWidth: 1))
    }
}
