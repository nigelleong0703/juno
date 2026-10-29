import SwiftUI

/// Agent profile as a sheet (tap the figure in a chat): Muse's layout, round close and share buttons over the header.
struct AgentCardView: View {
    @Environment(World.self) private var world
    var agentId: String
    var tab: String?

    var body: some View {
        NavigationStack {
            AgentProfileView(agentId: agentId, titled: false, startTab: tab)
                .toolbarBackgroundVisibility(.hidden, for: .navigationBar)
                .toolbar {
                    // `world.agentPage` is the one switch for this page (JunoTabBarController watches it and dismisses with the
                    // zoom back); SwiftUI's `dismiss` does not reach a UIKit-presented cover from inside a NavigationStack.
                    ToolbarItem(placement: .topBarLeading) { Button("Close", systemImage: "xmark") { world.agentPage = nil }.accessibilityIdentifier("agent-profile-close") }
                    ToolbarItem(placement: .topBarTrailing) {
                        ShareLink(item: "\(world.agent(agentId)?.name ?? "Agent") on Juno").accessibilityLabel("Share")
                    }
                }
                .junoDestinations()
        }
    }
}

/// Muse's agent profile: big figure with an edit pencil, name, status ("Free"); six icon-only tabs; Pause / Resume in the "…" menu.
/// Activity (task timeline) → task card · Approvals (audit) · Computer (live screen) · Automations · Memory (SOUL + a way into memory).
struct AgentProfileView: View {
    @Environment(World.self) private var world
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var agentId: String
    /// The card sheet has no title (the avatar header is the title); a pushed page keeps the agent's name.
    var titled = true
    var startTab: String?
    @State private var tab = ProfileTab.launch
    @State private var editing = false

    enum ProfileTab: String, CaseIterable, Identifiable {
        case activity, apps, approvals, computer, schedules, memory
        var id: String { rawValue }
        var title: String {
            switch self {
            case .activity: "Activity"
            case .apps: "Apps"
            case .approvals: "Permissions"
            case .computer: "Computer"
            case .schedules: "Automations"
            case .memory: "Memory"
            }
        }
        var icon: String {
            switch self {
            case .activity: "list.bullet"
            case .apps: "puzzlepiece.extension"
            case .approvals: "checkmark.shield"
            case .computer: "desktopcomputer"
            case .schedules: "clock.arrow.circlepath"
            case .memory: "touchid"
            }
        }
        /// `-profile computer` on launch picks the tab (Simulator screenshots).
        static var launch: ProfileTab { ProfileTab(rawValue: UserDefaults.standard.string(forKey: "profile") ?? "") ?? .activity }
    }

    var body: some View {
        VStack(spacing: 16) {
            ProfileHeader(agentId: agentId, onEdit: { editing = true })
            ProfileTabBar(tab: $tab, reduceMotion: reduceMotion)
                .padding(.horizontal, 16)
            TabView(selection: $tab) {
                ForEach(ProfileTab.allCases) { page in
                    ScrollView {
                        profilePage(page)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 16)
                            .padding(.bottom, 32)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Theme.canvas)
                    .contentShape(.rect)
                    .tag(page)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Theme.canvas)
        .onAppear { if let startTab, let page = ProfileTab(rawValue: startTab) { tab = page } }
        .pageHeader(titled ? (world.agent(agentId)?.name ?? "Agent") : "")
        .toolbar { ToolbarItem(placement: .topBarTrailing) { AgentProfileMenu(agentId: agentId) } }
        .sheet(isPresented: $editing) { AgentEditSheet(agentId: agentId) }
        .noDrawerSwipe()
    }

    @ViewBuilder
    private func profilePage(_ page: ProfileTab) -> some View {
        switch page {
        case .activity: ActivityTab(agentId: agentId)
        case .apps: AgentAppsSection(agentId: agentId)
        case .approvals: ApprovalsTab(agentId: agentId)
        case .computer: ComputerTab(agentId: agentId)
        case .schedules: SchedulesTab(agentId: agentId)
        case .memory: MemoryTab(agentId: agentId)
        }
    }
}

/// Six icon-only segments using the system segmented picker.
struct ProfileTabBar: View {
    @Binding var tab: AgentProfileView.ProfileTab
    var reduceMotion: Bool

    var body: some View {
        Picker("Agent profile section", selection: $tab.animation(reduceMotion ? nil : .snappy(duration: 0.2))) {
            ForEach(AgentProfileView.ProfileTab.allCases) { t in
                Label(t.title, systemImage: t.icon)
                    .labelStyle(.iconOnly)
                    .accessibilityLabel(t.title)
                    .accessibilityIdentifier("agent-profile-tab-\(t.rawValue)")
                    .tag(t)
            }
        }
        .pickerStyle(.segmented)
        .controlSize(.large)
        .labelsHidden()
        .accessibilityIdentifier("agent-profile-tabs")
    }
}

/// Figure with the pencil, name, status ("Free", the doing line with a Stop, or "Paused").
struct ProfileHeader: View {
    @Environment(World.self) private var world
    var agentId: String
    var onEdit: () -> Void

    var body: some View {
        let agent = world.agent(agentId)
        VStack(spacing: 6) {
            AvatarView(agent: agent, size: AvatarSize.profile)
                .overlay(alignment: .bottomTrailing) {
                    Button(action: onEdit) { Image(systemName: "pencil").font(.system(size: 12, weight: .semibold)) }
                        .buttonStyle(.glass).buttonBorderShape(.circle).controlSize(.small).tint(Theme.fg)
                    .offset(x: 4, y: 2)
                    .accessibilityLabel("Edit agent")
                }
                .padding(.top, 8)
            Text(agent?.name ?? "").text(.xl, .bold).foregroundStyle(Theme.fg).padding(.top, 6)
            // Idle: "Free", no buttons. Working: the doing line with one small Stop. Paused reads "Paused" in place of either
            // (Pause / Resume is in the top bar's "…" menu).
            let working = agent.map(isWorking) ?? false
            let paused = agent?.pausedAt != nil
            HStack(spacing: 8) {
                statusMark(live: working && !paused)
                Text(paused ? "Paused" : (agent.map { doing($0) } ?? statusLabel)).text(.md, .medium).foregroundStyle(Theme.fg).lineLimit(1)
                    .accessibilityIdentifier("agent-profile-doing")
                if working {
                    Button("Stop") { world.stopAgent(agentId) }
                        .buttonStyle(WebButton(variant: .secondary, size: .xs))
                        .accessibilityIdentifier("agent-profile-stop")
                }
            }
            .padding(.horizontal, 24)
        }
        .frame(maxWidth: .infinity)
    }

    private func isWorking(_ agent: Agent) -> Bool {
        !world.activeRuns(of: agent.id).isEmpty || world.tasks[agent.id]?.contains { $0.status == "running" } == true
    }

    /// Under the name: what it is doing right now, or that it waits on you; otherwise its plain status ("Free").
    /// An idle agent's last task title (raw text like "@all 介绍你们是谁吧") belongs in the Activity list, not here.
    private func doing(_ agent: Agent) -> String {
        if isWorking(agent) || (agent.needsYou ?? 0) > 0 || !world.needsYou(of: agent.id).isEmpty {
            let line = world.doingLine(agent)
            return line == World.freeLine ? statusLabel : line
        }
        return statusLabel
    }

    private var statusLabel: String {
        switch world.agent(agentId)?.status {
        case "sleeping": "Sleeping"
        case "error": "Error"
        case "needs_you": "Needs you"
        default: World.freeLine
        }
    }

    /// The live dot Team › Agents uses (green while working, grey when free); sleeping, needs-you and error keep their symbol.
    @ViewBuilder private func statusMark(live: Bool) -> some View {
        switch world.agent(agentId)?.status {
        case "sleeping": Image(systemName: "moon.circle.fill").text(.lg).foregroundStyle(Color.secondary)
        case "error": Image(systemName: "exclamationmark.circle.fill").text(.lg).foregroundStyle(Theme.danger)
        case "needs_you": Image(systemName: "exclamationmark.circle.fill").text(.lg).foregroundStyle(Theme.warning)
        default: Circle().fill(live ? Theme.success : Theme.fgSubtle.opacity(0.5)).frame(width: 8, height: 8)
        }
    }
}

/// The profile's top-bar "…" menu: Pause or Resume (F-09). It follows `pausedAt`, not `status`: a paused agent shows Resume
/// even while it is still finishing work.
private struct AgentProfileMenu: View {
    @Environment(World.self) private var world
    var agentId: String

    var body: some View {
        let paused = world.agent(agentId)?.pausedAt != nil
        Menu {
            Button(paused ? "Resume" : "Pause", systemImage: paused ? "play.fill" : "pause.fill") {
                world.setAgentPaused(agentId, !paused)
            }
            .accessibilityIdentifier("agent-profile-pause")
        } label: {
            Image(systemName: "ellipsis")
        }
        .accessibilityLabel("More")
        .accessibilityIdentifier("agent-profile-menu")
    }
}

/// Bold section header used by every tab ("Today", "Approval history", "Daily").
struct TabHeader: View {
    var title: String
    var body: some View { Text(title).text(.lg, .semibold).foregroundStyle(Theme.fg).padding(.top, 4) }
}

struct EmptyLine: View {
    var text: String
    var body: some View { Text(text).text(.base).foregroundStyle(Theme.fgSubtle) }
}

struct ShowMore: View {
    var shown: Int
    var total: Int
    var more: () -> Void
    var body: some View {
        if total > shown {
            Button("Show more", action: more).buttonStyle(WebButton(variant: .secondary)).frame(maxWidth: .infinity)
        }
    }
}

// MARK: - Activity: the agent's tasks (running first, then by day)

struct ActivityTab: View {
    @Environment(World.self) private var world
    var agentId: String
    @State private var limit = 12
    @State private var open: String?

    var body: some View {
        let all = world.taskList(agentId)
        let layout = TaskGroups.layout(all, limit: limit)
        VStack(alignment: .leading, spacing: 14) {
            if all.isEmpty { EmptyLine(text: "No tasks yet. Tasks show up here as the agent works.") }
            if !layout.active.isEmpty {
                TabHeader(title: "Now")
                ForEach(layout.active) { TaskEntryRows(entry: $0, open: $open) }
            }
            ForEach(layout.days, id: \.title) { day in
                TabHeader(title: day.title)
                ForEach(day.entries) { TaskEntryRows(entry: $0, open: $open) }
            }
            if layout.finishedTotal > limit {
                ShowMore(shown: limit, total: layout.finishedTotal) { limit += 12 }
            } else if world.taskNext[agentId] != nil {
                // Everything loaded is shown: fetch the next page of older tasks.
                Button("Show more") { world.loadMoreTasks(agentId); limit += 12 }.buttonStyle(WebButton(variant: .secondary)).frame(maxWidth: .infinity)
            }
        }
        .task { world.loadTasks(agentId) }
        .taskCardSheet($open)
    }
}

/// Tasks hang under their parent and routine runs under their routine; a count folds them away and opens them a few at a time.
struct TaskEntryRows: View {
    @Environment(World.self) private var world
    var entry: TaskEntry
    @Binding var open: String?

    var body: some View {
        switch entry {
        case .task(let node): TaskTreeRow(node: node, open: $open, nested: false)
        case .routine(let id, let runs): RoutineRunsRow(title: world.routines.first { $0.id == id }?.name ?? "Routine", runs: runs, open: $open)
        }
    }
}

/// Children shown under a parent before "Show more".
private let childrenPage = 5

struct TaskTreeRow: View {
    var node: TaskNode
    @Binding var open: String?
    var nested: Bool
    @State private var expanded: Bool
    @State private var shown = childrenPage

    init(node: TaskNode, open: Binding<String?>, nested: Bool) {
        self.node = node
        _open = open
        self.nested = nested
        // A group with a descendant that needs the person starts open.
        _expanded = State(initialValue: Self.startsExpanded(node))
    }

    static func startsExpanded(_ node: TaskNode) -> Bool { node.descendantsNeedingYou != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            OpenableTaskRow(task: node.task, open: $open, nested: nested, count: node.children.count, expanded: $expanded, below: node.descendantsNeedingYou)
            if expanded {
                VStack(alignment: .leading, spacing: 8) {
                    // Children that need the person (or hold one that does) list first, so the cap never hides them.
                    ForEach(node.children.sorted { $0.subtreeNeedsYou && !$1.subtreeNeedsYou }.prefix(shown)) { TaskTreeRow(node: $0, open: $open, nested: true) }
                    ShowMore(shown: shown, total: node.children.count) { shown += childrenPage }
                }.padding(.leading, 24)
            }
        }
    }
}

struct RoutineRunsRow: View {
    @Environment(World.self) private var world
    var title: String
    var runs: [TaskNode]
    @Binding var open: String?
    @State private var expanded = false
    @State private var shown = childrenPage

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            let live = runs.contains { TaskGroups.isActive($0.task) }
            Button { expanded.toggle() } label: {
                HStack(spacing: 12) {
                    Image(systemName: "calendar.badge.clock").text(.lg).foregroundStyle(Theme.fgMuted)
                        .frame(width: 40, height: 40).background(live ? Theme.requestCard : Theme.muted, in: .rect(cornerRadius: Radius.lg))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).text(.md, .semibold).foregroundStyle(Theme.fg).lineLimit(2).multilineTextAlignment(.leading)
                        if let newest = runs.first?.task { Text(TaskWords.subtitle(newest, agentName: world.agent(newest.agentId)?.name)).text(.base).foregroundStyle(Theme.fgMuted).lineLimit(2).multilineTextAlignment(.leading) }
                    }
                    Spacer(minLength: 0)
                    TaskCountLabel(text: "Runs (\(runs.count))", expanded: expanded)
                }
                .padding(live ? 10 : 0)
                .background(live ? Theme.muted : .clear, in: .rect(cornerRadius: Radius.xl))
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            if expanded {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(runs.prefix(shown)) { TaskTreeRow(node: $0, open: $open, nested: true) }
                    ShowMore(shown: shown, total: runs.count) { shown += childrenPage }
                }.padding(.leading, 24)
            }
        }
    }
}

struct TaskCountLabel: View {
    var text: String
    var expanded: Bool
    var body: some View {
        HStack(spacing: 4) {
            Text(text).text(.sm, .medium)
            Image(systemName: expanded ? "chevron.down" : "chevron.right").font(.caption2)
        }
        .foregroundStyle(Theme.fgMuted)
    }
}

private struct TaskPick: Identifiable { var id: String }

extension View {
    /// Presents the TaskCard for the run id in `open` (shared by the Activity tab and the workspace's task list).
    func taskCardSheet(_ open: Binding<String?>) -> some View {
        sheet(item: Binding(get: { open.wrappedValue.map(TaskPick.init) }, set: { open.wrappedValue = $0?.id })) {
            TaskCard(runId: $0.id).junoSheetPresentation(long: true)
        }
    }
}

/// A TaskRow that opens its card when tapped, or the conversation holding its request card when it needs the person.
/// `count` > 0 adds the toggle that folds its children.
struct OpenableTaskRow: View {
    @Environment(World.self) private var world
    var task: Contract.AgentTask
    @Binding var open: String?
    var nested = false
    var count = 0
    var expanded: Binding<Bool>?
    var below: (label: String, tone: StatusTone, line: String)?
    var body: some View {
        TaskRow(task: task, nested: nested, count: count, expanded: expanded?.wrappedValue ?? false, below: below, onToggle: { expanded?.wrappedValue.toggle() }, onStop: { world.stopTask(task) })
            .contentShape(.rect)
            .onTapGesture {
                if let conversationId = TaskWords.needsYou(task) { world.openChat(conversationId) }
                else if let run = task.childRunId ?? task.runId { open = run }
            }
            .accessibilityIdentifier("task-row")
    }
}

/// The workspace Computer tab's tasks under the live screen: Now (running and waiting, capped) then Today
/// (finished today, a few at a time). Nothing when there are none.
struct WorkspaceTasks: View {
    @Environment(World.self) private var world
    var agentId: String
    @State private var limit = 5
    @State private var open: String?

    var body: some View {
        let layout = TaskGroups.layout(world.taskList(agentId), limit: .max)
        let now = Array(layout.active.prefix(10))
        let today = layout.days.first { $0.title == "Today" }?.entries ?? []
        VStack(alignment: .leading, spacing: 14) {
            if !now.isEmpty {
                TabHeader(title: "Now")
                ForEach(now) { TaskEntryRows(entry: $0, open: $open) }
            }
            if !today.isEmpty {
                TabHeader(title: "Today")
                ForEach(today.prefix(limit)) { TaskEntryRows(entry: $0, open: $open) }
                ShowMore(shown: min(limit, today.count), total: today.count) { limit += 5 }
            }
        }
        .task(id: agentId) { world.loadTasks(agentId) }
        .taskCardSheet($open)
    }
}

/// Muse's task row: an icon tile by kind, bold title, grey progress / outcome, time. A running task is highlighted
/// with a round Stop; a waiting one says it is waiting for you.
struct TaskRow: View {
    @Environment(World.self) private var world
    var task: Contract.AgentTask
    var nested = false
    var count = 0
    var expanded = false
    /// Set on a parent with a descendant that needs the person: the pill and the "N need you" line.
    var below: (label: String, tone: StatusTone, line: String)?
    var onToggle: () -> Void = {}
    var onStop: () -> Void

    static func symbol(_ kind: String?) -> String {
        switch kind {
        case "subagent": "person.2"
        case "routine": "calendar.badge.clock"
        case "command": "terminal"
        case "connector": "puzzlepiece.extension"
        case "wait": "hourglass"
        default: "square.grid.2x2"
        }
    }

    private var routineName: String? {
        task.origin?.type == "routine" ? world.routines.first { $0.id == task.origin?.routineId }?.name : nil
    }

    var body: some View {
        let active = TaskGroups.isActive(task)
        let needsYou = task.status == "waiting" || task.outcome == "needs_input" || task.outcome == "unknown_effect"
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: Self.symbol(task.kind)).text(.lg).foregroundStyle(Theme.fgMuted)
                .frame(width: 40, height: 40).background(active ? Theme.requestCard : Theme.muted, in: .rect(cornerRadius: Radius.lg))
            VStack(alignment: .leading, spacing: 2) {
                Text(task.title ?? "Task").text(.md, .semibold).foregroundStyle(Theme.fg).lineLimit(2).multilineTextAlignment(.leading)
                if let below {
                    Text(below.label).text(.sm, .medium).foregroundStyle(below.tone.color)
                        .padding(.horizontal, 8).padding(.vertical, 2).background(below.tone.color.opacity(0.14), in: .rect(cornerRadius: 8))
                    Text(below.line).text(.base).foregroundStyle(Theme.warning)
                }
                Text(TaskWords.subtitle(task, agentName: world.agent(task.agentId)?.name)).text(.base).foregroundStyle(needsYou ? Theme.warning : Theme.fgMuted).lineLimit(2).multilineTextAlignment(.leading)
                Text(nested ? Fmt.time(task.startedAt) : "\(Fmt.time(task.startedAt)) \u{00B7} \(task.origin?.startedByLine(routineName: routineName) ?? "")")
                    .text(.sm).foregroundStyle(Theme.fgSubtle)
            }
            Spacer(minLength: 0)
            if count > 0 { Button(action: onToggle) { TaskCountLabel(text: "Tasks (\(count))", expanded: expanded) }.buttonStyle(.plain) }
            if task.status == "running" { RoundStopButton(action: onStop) }
        }
        .padding(active ? 10 : 0)
        .background(active ? Theme.muted : .clear, in: .rect(cornerRadius: Radius.xl))
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Muse's task card: a status pill, the title, when it started, what the agent says happened (its own task text,
/// never raw tool output), the latest screenshot, then the steps in plain words.
struct TaskCard: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var runId: String
    @State private var shot: UIImage?
    @State private var viewing = false

    /// The agent-written line for this run: the task's outcome once finished, its progress while running.
    static func summary(_ task: Contract.AgentTask?) -> String? {
        guard let task else { return nil }
        let text = TaskGroups.isActive(task) ? task.progress.map(progressText) : (task.resultLine ?? task.progress)
        return text?.isEmpty == false ? text : nil
    }

    private func started(_ run: Run?) -> String {
        guard let at = run?.startedAt else { return "" }
        let ms = run?.durationMs ?? run?.finishedAt.map { Int($0.timeIntervalSince(at) * 1000) }
        let took = run?.status == "running" ? nil : ms.map { " · " + Fmt.duration($0) }
        return (run?.finishedAt.map { "Finished \(Fmt.time($0))" } ?? "Started \(Fmt.time(at))") + (took ?? "")
    }

    var body: some View {
        let run = world.run(runId)
        let task = world.tasks.values.joined().first { ($0.childRunId ?? $0.runId) == runId }
        let children = world.children(of: runId)
        // The task's own verdict wins: a run can end "completed" with the task failed.
        let phase = task.map(TaskWords.phase)
        let status = run?.status
        let tone = phase?.tone ?? StatusTone(status)
        let screenshotId = run?.steps?.last { $0.screenshotRef != nil }?.screenshotRef
        NavigationStack { ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text(phase?.label ?? (status == "completed" ? "Completed" : Fmt.status(status))).text(.sm, .medium)
                        .foregroundStyle(tone == .neutral ? Theme.fg : tone.color)
                        .padding(.horizontal, 10).padding(.vertical, 4)
                        .background(tone.color.opacity(0.14), in: .rect(cornerRadius: 8))
                    Spacer()
                }
                Text(world.taskTitle(for: run) ?? "Activity").text(.xl, .bold).foregroundStyle(Theme.fg)
                Text(started(run) + (task?.origin.map { origin in " \u{00B7} " + origin.startedByLine(routineName: world.routines.first { $0.id == origin.routineId }?.name) } ?? ""))
                    .text(.base).foregroundStyle(Theme.fgSubtle)
                if let task, let detail = TaskWords.detail(task, agentName: world.agent(task.agentId)?.name) { Text(detail).text(.md).foregroundStyle(Theme.fgMuted) }
                if let error = run?.error { Text(Fmt.runError(error)).text(.md).foregroundStyle(Theme.danger) }
                if let s = run?.summary ?? Self.summary(task) { Text(s).text(.md).foregroundStyle(Theme.fgMuted) }
                if let shot {
                    Button { viewing = true } label: {
                        Image(uiImage: shot).resizable().scaledToFit().frame(maxWidth: .infinity)
                            .clipShape(.rect(cornerRadius: Radius.xl))
                            .overlay(RoundedRectangle(cornerRadius: Radius.xl).stroke(Theme.border, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .sheet(isPresented: $viewing) { ImageViewer(image: shot) }
                }
                StepSection(label: "Main", steps: run?.steps ?? [])
                ForEach(children) { child in
                    StepSection(label: child.title ?? "Helper", status: child.status, steps: child.steps ?? [])
                }
            }
            .padding(.top, 20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .toolbar { CloseButton(identifier: "task-card-close") }
        .toolbarBackgroundVisibility(.hidden, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .background(Theme.panel)
        .task(id: screenshotId) { if let id = screenshotId { shot = await world.previewImage(id) } }
        }
        .presentationCornerRadius(32)
        .task(id: children.map(\.id)) { world.loadSteps(runId); await world.loadChildren(of: runId) }
    }
}

/// One titled list of steps, capped with "Show more".
private struct StepSection: View {
    var label: String
    var status: String?
    var steps: [Step]
    @State private var shown = 8

    var body: some View {
        let all = visibleSteps(steps)
        let live = status == "running" || status == "queued"
        if !all.isEmpty || live || status == "failed" {
            Divider().overlay(Theme.border)
            HStack(spacing: 6) {
                Text(label).text(.sm, .medium).foregroundStyle(Theme.fgSubtle).lineLimit(2)
                if live { ProgressView().controlSize(.mini) }
                else if status == "failed" { Text("Failed").text(.xs, .medium).foregroundStyle(Theme.danger) }
                else if status == "completed" { Image(systemName: "checkmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.fgSubtle) }
            }
            StepTimeline(steps: Array(all.prefix(shown)), run: steps)
            ShowMore(shown: min(shown, all.count), total: all.count) { shown += 8 }
        }
    }
}

// MARK: - Computer: a live preview of the agent's screen; "Open browser" goes straight into control

struct ComputerTab: View {
    @Environment(World.self) private var world
    var agentId: String
    @State private var controlling = false

    var body: some View {
        let active = world.activeRuns(of: agentId)
        let browserTasks = world.runs.filter { $0.agentId == agentId && ($0.steps ?? []).contains { $0.kind == "browser" } }.count
        let hasPicture = world.screenshots[agentId] != nil || (world.api != nil && world.hasScreen(agentId))
        VStack(alignment: .leading, spacing: 14) {
            if hasPicture {
                preview
            } else if browserTasks > 0 || !active.isEmpty {
                HStack {
                    Text("\(max(browserTasks, 1)) browser task\(browserTasks > 1 ? "s" : "")").text(.lg, .medium).foregroundStyle(Theme.fg)
                    Spacer()
                    ProgressView()
                }
                Text(active.isEmpty ? "No screen yet" : "Starting browser…").text(.md).foregroundStyle(Theme.fg)
            } else {
                EmptyLine(text: "No browser activity yet.")
            }
        }
        .fullScreenCover(isPresented: $controlling) { TakeoverView(agentId: agentId) }
    }

    /// The latest picture (or the live stream), light and rounded, with the glass "Open browser" button in its corner.
    private var preview: some View {
        Group {
            if world.api != nil { ScreenFrame(agentId: agentId) }
            else if let shot = world.screenshots[agentId] {
                Image(uiImage: shot).resizable().scaledToFit()
                    .frame(maxWidth: .infinity)
                    .background(Theme.muted)
                    .clipShape(.rect(cornerRadius: Radius.xl))
            }
        }
        .overlay(alignment: .bottomTrailing) {
            Button { controlling = true } label: {
                HStack(spacing: 6) { Text("Open browser"); Image(systemName: "arrow.up.left.and.arrow.down.right").font(.system(size: 11, weight: .semibold)) }
            }
            .buttonStyle(.glass).tint(Theme.fg)
            .padding(12)
        }
    }
}

// MARK: - Automations: every routine for this agent, with the on/off switch

struct SchedulesTab: View {
    @Environment(World.self) private var world
    var agentId: String
    @State private var limit = 12
    @State private var deleting: Routine?

    private var rows: [Routine] {
        world.routines.filter { $0.agentId == agentId }.sorted { ($0.name ?? "").localizedCaseInsensitiveCompare($1.name ?? "") == .orderedAscending }
    }

    var body: some View {
        let all = rows
        let shown = Array(all.prefix(limit))
        VStack(alignment: .leading, spacing: 14) {
            ForEach(shown) { routine in
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .center, spacing: 12) {
                        Image(systemName: "calendar.badge.clock").font(.system(size: 18)).foregroundStyle(Theme.fgMuted)
                            .frame(width: 36, height: 36).background(Theme.muted, in: .rect(cornerRadius: 9))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(routine.name ?? "").text(.lg, .semibold).foregroundStyle(Theme.fg).lineLimit(2)
                            if let schedule = routine.trigger?.human, !schedule.isEmpty { Text(schedule).text(.md).foregroundStyle(Theme.fgMuted).lineLimit(1) }
                        }
                        Spacer(minLength: 8)
                        Toggle("Enabled", isOn: Binding(get: { routine.runs }, set: { _ in world.toggleRoutine(routine.id) }))
                            .labelsHidden().tint(Theme.success).disabled(routine.needsSetup)
                        Menu {
                            Button("Delete", systemImage: "trash", role: .destructive) { deleting = routine }
                        } label: {
                            Image(systemName: "ellipsis").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.fgMuted)
                                .frame(width: 32, height: 36).contentShape(.rect)
                        }
                        .accessibilityLabel("More")
                    }
                    RoutineSetupNote(routine: routine).padding(.leading, 48)
                }
                .contextMenu {
                    Button("Delete", systemImage: "trash", role: .destructive) { deleting = routine }
                }
            }
            ShowMore(shown: shown.count, total: all.count) { limit += 12 }
            Button {
                world.openChat(world.directConversation(for: agentId)?.id, draft: "")
            } label: {
                Label("New automation", systemImage: "plus").frame(maxWidth: .infinity)
            }
            .buttonStyle(.glass).controlSize(.large).tint(Theme.fg)
        }
        .confirmationDialog("Delete this schedule? It won't run again.", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                if let routine = deleting { world.deleteRoutine(routine.id) }
                deleting = nil
            }
            Button("Cancel", role: .cancel) { deleting = nil }
        }
    }
}

// MARK: - Memory: SOUL (the identity text) and what it remembers

struct MemoryTab: View {
    @Environment(World.self) private var world
    var agentId: String
    @State private var editingSoul = false
    @State private var showingMemories = false

    var body: some View {
        let agent = world.agent(agentId)
        VStack(alignment: .leading, spacing: 14) {
            TabHeader(title: agent?.name ?? "")
            Button { editingSoul = true } label: { Label("Edit", systemImage: "pencil").frame(maxWidth: .infinity) }
                .buttonStyle(.glass).controlSize(.large).tint(Theme.fg)
            HStack(spacing: 12) {
                MemoryCard(title: "Identity", subtitle: "Persona & instructions", date: nil, symbol: "heart.fill",
                           colors: [Color(uiColor: UIColor(hex: UInt32(0x4a3a66))), Color(uiColor: UIColor(hex: UInt32(0x8d72ad)))]) { editingSoul = true }
                MemoryCard(title: "Memory", subtitle: "Shared by all your agents", date: nil, symbol: "bubble.fill",
                           colors: [Color(uiColor: UIColor(hex: UInt32(0x4f5a12))), Color(uiColor: UIColor(hex: UInt32(0x1d2208)))]) { showingMemories = true }
            }
            LearnedReplyStyle(agentId: agentId)
        }
        .sheet(isPresented: $editingSoul) { SoulEditSheet(agentId: agentId) }
        .sheet(isPresented: $showingMemories) { MemorySheet().junoSheetPresentation(long: true) }
    }
}

/// A square-ish gradient card: title and subtitle on top, date and icon along the bottom.
private struct MemoryCard: View {
    var title: String
    var subtitle: String
    var date: Date?
    var symbol: String
    var colors: [Color]
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).text(.lg, .bold).foregroundStyle(.white)
                Text(subtitle).font(.system(size: 9)).foregroundStyle(.white.opacity(0.7))
                Spacer(minLength: 0)
                HStack(alignment: .bottom) {
                    if let date {
                        Text(date.formatted(.dateTime.month(.twoDigits).day(.twoDigits).year(.twoDigits)).replacingOccurrences(of: "/", with: "."))
                            .font(.system(size: 11, design: .monospaced)).foregroundStyle(.white.opacity(0.55))
                    }
                    Spacer()
                    Image(systemName: symbol).font(.system(size: 18)).foregroundStyle(.white.opacity(0.6))
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity).frame(height: 130, alignment: .topLeading)
            .background(LinearGradient(colors: colors, startPoint: .topLeading, endPoint: .bottomTrailing), in: .rect(cornerRadius: 22))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Edit sheets (drafts; saved with PATCH /v1/agents/:id)

struct AgentEditSheet: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var agentId: String
    @State private var draft: Agent?
    @State private var isSaving = false
    @State private var saveError: String?

    var body: some View {
        JunoSheet(icon: "person.crop.circle", title: "Edit agent", guidance: nil, primary: "Save",
                  primaryEnabled: draft?.name?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false, loading: isSaving, long: true,
                  id: "agent-edit", onPrimary: { Task { await save() } }, onCancel: { dismiss() }) {
            if let draft {
                VStack(spacing: 12) {
                    AvatarView(agent: draft, size: 104)
                        .frame(width: 120, height: 120)
                        .accessibilityHidden(true)
                    Text(draft.name?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? (draft.name ?? "Your agent") : "Your agent")
                        .text(.lg, .semibold)
                        .foregroundStyle(Theme.fg)
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)

                AvatarCharacterPicker(
                    selection: Binding(
                        get: { agentCharacter(draft) },
                        set: { character in
                            var updated = draft
                            var avatar = updated.avatar ?? Avatar()
                            avatar.character = character
                            updated.avatar = avatar
                            self.draft = updated
                        }
                    ),
                    agentId: draft.id
                )

                JunoFormField(label: "Name") {
                    TextField("Agent name", text: Binding(get: { draft.name ?? "" }, set: { self.draft?.name = $0 }))
                        .textInputAutocapitalization(.words).autocorrectionDisabled()
                        .accessibilityIdentifier("agent-edit-name").inputField()
                }
                JunoFormField(label: "Role", optional: true) {
                    TextField("What this agent does", text: Binding(get: { draft.title ?? "" }, set: { self.draft?.title = $0 }))
                        .textInputAutocapitalization(.words)
                        .accessibilityIdentifier("agent-edit-role").inputField()
                }
                if let saveError { JunoMessage(text: saveError, id: "agent-edit-error") }
            } else {
                ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
            }
        }
        .task { if draft == nil { draft = world.agent(agentId) } }
        .interactiveDismissDisabled(isSaving)
    }

    @MainActor
    private func save() async {
        guard var draft else { return }
        let trimmedName = draft.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmedName.isEmpty else { return }
        draft.name = trimmedName
        isSaving = true
        saveError = nil
        do {
            try await world.saveAgentProfile(draft)
            dismiss()
        } catch {
            saveError = error.localizedDescription
            isSaving = false
        }
    }
}


/// The agent's four identity files in its home (IDENTITY / SOUL / AGENTS / TOOLS.md), loaded and saved through
/// /v1/home. Each save carries the hash it was loaded with; a file changed elsewhere is reloaded, not overwritten.
struct SoulEditSheet: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var agentId: String

    private static let fields: [(file: String, label: String, hint: String?, note: String)] = [
        ("IDENTITY.md", "Persona", "Who this agent is.",
         "About this file. This is %@'s persona: who %@ is. It starts from what you set when %@ was created, and only you change it. You can edit it at any time. This note is not part of the file."),
        ("SOUL.md", "Principles & tone", nil,
         "About this file. This is %@'s persona. It sets out the values and tone %@ tries to hold to in every conversation. It starts from what you set when %@ was created, and only you change it. You can edit it at any time. This note is not part of the file."),
        ("AGENTS.md", "Working instructions", "A \"## When to reach out\" section here controls when this agent messages you on its own.",
         "About this file. These are %@'s working instructions: how %@ does its work and when it reaches out to you on its own. It starts from what you set when %@ was created, and only you change it. You can edit it at any time. This note is not part of the file."),
        ("TOOLS.md", "Tool notes", nil,
         "About this file. These are %@'s notes on its tools and how to use them. It starts from what you set when %@ was created, and only you change it. You can edit it at any time. This note is not part of the file."),
    ]

    @State private var texts: [String: String] = [:]
    @State private var loaded: [String: Contract.AgentHomeFile] = [:]
    @State private var isLoading = true
    @State private var isSaving = false
    @State private var error: String?

    private var prefix: String { "agents/\(agentId)/" }
    /// Same rule as the web: editable unless a creator is recorded and is someone else.
    private var canEdit: Bool {
        guard let creator = world.agent(agentId)?.createdBy else { return true }
        return creator == world.selfId
    }
    private func served(_ file: String) -> String { loaded[prefix + file]?.content ?? "" }
    private var changed: [String] { Self.fields.map(\.file).filter { texts[$0] != served($0) } }

    var body: some View {
        JunoSheet(icon: "sparkles", title: "Identity", guidance: "The agent's identity files. It reads them at the start of every task.",
                  note: canEdit ? nil : "Only the person who created this agent can edit its identity.",
                  primary: "Save", primaryEnabled: canEdit && !isLoading && !isSaving && !changed.isEmpty, loading: isLoading || isSaving,
                  long: true, id: "identity", onPrimary: { Task { await save() } }, onCancel: { dismiss() }) {
            ForEach(Self.fields, id: \.file) { field in
                JunoFormField(label: field.label, help: field.hint) {
                    FileNote(text: field.note.replacingOccurrences(of: "%@", with: world.agent(agentId)?.name ?? "This agent"))
                    TextField(field.label, text: Binding(get: { texts[field.file] ?? "" }, set: { texts[field.file] = $0 }), axis: .vertical)
                        .lineLimit(3...14).padding(.vertical, 12).inputField()
                        .disabled(!canEdit || isLoading || isSaving)
                        .accessibilityIdentifier("identity-\(field.file)")
                }
            }
            if let error { Text(error).text(.sm).foregroundStyle(Theme.danger) }
        }
        .task { await load() }
    }

    @MainActor private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let files = try await world.homeFiles(prefix)
            loaded = Dictionary(files.compactMap { f in f.path.map { ($0, f) } }, uniquingKeysWith: { $1 })
            texts = Dictionary(uniqueKeysWithValues: Self.fields.map { ($0.file, served($0.file)) })
        } catch {
            self.error = error.localizedDescription
        }
    }

    @MainActor private func save() async {
        isSaving = true
        error = nil
        var conflicts: [String] = []
        do {
            for field in Self.fields where changed.contains(field.file) {
                do {
                    try await world.writeHomeFile(prefix + field.file, content: texts[field.file] ?? "", expectedHash: loaded[prefix + field.file]?.hash)
                } catch let failure where failure.isHomeConflict {
                    conflicts.append(field.label)
                }
            }
        } catch {
            self.error = error.localizedDescription
            isSaving = false
            return
        }
        if conflicts.isEmpty {
            dismiss()
        } else {
            await load()
            error = "\(conflicts.joined(separator: ", ")) changed elsewhere and was reloaded. Review it and make your edit again."
            isSaving = false
        }
    }
}

/// One learned rule: a sentence, and the claim it rests on when the file names one (`[claim:<id>]`).
struct ReplyRule: Hashable, Identifiable {
    var text: String
    var claimId: String?
    var id: String { claimId ?? text }
}

/// One rule with "Forget this": it asks first, then retracts the claim (`POST /v1/memory/forget`), which reloads the file.
private struct ReplyRuleSheet: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var rule: ReplyRule
    @State private var confirming = false
    @State private var failure: String?

    var body: some View {
        JunoSheet(icon: "text.bubble", title: "Learned reply style", cancel: "Close", fitsContent: true, id: "reply-rule", onCancel: { dismiss() }) {
            Text(rule.text).text(.lg).foregroundStyle(Theme.fg).fixedSize(horizontal: false, vertical: true)
            if let failure { JunoMessage(text: failure) }
            Button { confirming = true } label: { Text("Forget this").foregroundStyle(Theme.danger).frame(maxWidth: .infinity) }
                .buttonStyle(WebButton(variant: .secondary, size: .large))
                .accessibilityIdentifier("reply-rule-forget")
        }
        .confirmationDialog("Forget this?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Forget this", role: .destructive) { Task { await forget() } }
        } message: {
            Text("The agents stop following it, and what it was learned from is removed from your memory.")
        }
    }

    @MainActor private func forget() async {
        guard let claimId = rule.claimId else { return }
        do {
            try await world.forgetMemory([claimId])
            dismiss()
        } catch where !error.isCancellation {
            failure = error.localizedDescription
        } catch {}
    }
}

/// What the platform learned about how the user likes to be answered (ALIGNMENT_SYNTHESIS.md), as a short list of plain
/// sentences under one muted line ("Learned from your conversations · updated 24 Oct 2026"); six, then "Show N more". A rule
/// that rests on a claim is a dotted-underlined phrase (Memory's); a tap opens it with "Forget this" (after a confirm), which
/// retracts the claim and reloads the file. The file is the shared body plus this agent's own `## <name>（<id>）` section.
struct LearnedReplyStyle: View {
    @Environment(World.self) private var world
    var agentId: String
    @State private var text: String?
    @State private var showAll = false
    @State private var open: ReplyRule?

    private static let limit = 6

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Learned reply style").text(.lg, .semibold).foregroundStyle(Theme.fg)
            if let text {
                let style = Self.parse(text)
                if style.rules.isEmpty {
                    Text("\(world.agent(agentId)?.name ?? "This agent") learns how you like to be answered from your conversations over time.")
                        .text(.base).foregroundStyle(Theme.fgMuted)
                } else {
                    Text(source(style.updated)).text(.sm).foregroundStyle(Theme.fgSubtle)
                    let shown = showAll ? style.rules : Array(style.rules.prefix(Self.limit))
                    VStack(alignment: .leading, spacing: 14) {
                        ForEach(Array(shown.enumerated()), id: \.offset) { _, rule in row(rule) }
                    }
                    if style.rules.count > shown.count {
                        ShowMoreButton(title: "Show \(style.rules.count - shown.count) more") { withAnimation { showAll = true } }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: world.homeRevision) {
            let file = try? await world.homeFiles("ALIGNMENT_SYNTHESIS.md").first { $0.path == "ALIGNMENT_SYNTHESIS.md" }
            text = Self.replyStyle(file?.content ?? "", agentId: agentId)
        }
        .sheet(item: $open) { ReplyRuleSheet(rule: $0) }
    }

    private func source(_ updated: Date?) -> String {
        guard let updated else { return "Learned from your conversations" }
        return "Learned from your conversations \u{00B7} updated \(updated.formatted(date: .abbreviated, time: .omitted))"
    }

    /// Memory's dotted-underlined phrase.
    private func dotted(_ text: String) -> AttributedString {
        var phrase = AttributedString(text)
        phrase.underlineStyle = Text.LineStyle(pattern: .dot, color: Theme.fg.opacity(0.35))
        return phrase
    }

    @ViewBuilder private func row(_ rule: ReplyRule) -> some View {
        if rule.claimId != nil {
            Button { open = rule } label: {
                Text(dotted(rule.text)).text(.md).foregroundStyle(Theme.fg).multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("reply-rule")
        } else {
            Text(rule.text).text(.md).foregroundStyle(Theme.fg)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// The rules of the file's text (already narrowed to this agent by `replyStyle`) and the day it says it was last updated from:
    /// `#` titles and headings are dropped, each "- " bullet is one rule with its `[claim:<id>]` marker stripped (the id kept), and a
    /// file with no bullets reads its plain lines as the rules. A file without a header or a date line works the same.
    static func parse(_ content: String) -> (rules: [ReplyRule], updated: Date?) {
        var updated: Date?
        var bullets: [ReplyRule] = []
        var plain: [ReplyRule] = []
        for raw in content.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }
            if let date = line.firstMatch(of: /(?i)^\W*last updated(?: from)?\s+(\d{4})-(\d{2})-(\d{2})/) {
                if updated == nil {
                    updated = Calendar.current.date(from: DateComponents(year: Int(date.1), month: Int(date.2), day: Int(date.3)))
                }
                continue
            }
            let isBullet = line.hasPrefix("- ") || line.hasPrefix("* ")
            var body = isBullet ? String(line.dropFirst(2)) : line
            var claimId: String?
            for marker in body.matches(of: /\s*\[claim:([^\]\s]+)\]/) where claimId == nil { claimId = String(marker.1) }
            body = body.replacing(/\s*\[claim:[^\]\s]+\]/, with: "").trimmingCharacters(in: .whitespaces)
            if body.isEmpty { continue }
            if isBullet { bullets.append(ReplyRule(text: body, claimId: claimId)) } else { plain.append(ReplyRule(text: body, claimId: claimId)) }
        }
        return (bullets.isEmpty ? plain : bullets, updated)
    }

    /// Drops the other agents' `## name（id）` sections; keeps the shared body and this agent's.
    static func replyStyle(_ content: String, agentId: String) -> String {
        var kept: [String] = []
        var keep = true
        for line in content.components(separatedBy: "\n") {
            if line.hasPrefix("## ") {
                if let open = line.lastIndex(of: "（"), line.hasSuffix("）") {
                    keep = line[line.index(after: open)..<line.index(before: line.endIndex)] == agentId
                } else { keep = true }
            }
            if keep { kept.append(line) }
        }
        return kept.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

// MARK: - Global pages (system lists over the mock data)

struct GlobalPageView: View {
    @Environment(World.self) private var world
    var page: GlobalPage
    @State private var query = ""
    @State private var deletingRoutine: Routine?
    /// Rules page only: the Activity tab instead of the rules list.
    @State private var showsActivity = false

    var body: some View {
        if page == .library {
            LibraryPage()
        } else if page == .memory {
            MemoryPage()
        } else {
            List {
            switch page {
            case .routines:
                ForEach(world.routines.filter(match(\.name))) { r in
                    VStack(alignment: .leading, spacing: 6) {
                        AgentRow(agent: world.agent(r.agentId), title: r.name ?? "", subtitle: r.trigger?.human, trailing: r.needsSetup ? "Needs setup" : r.runs ? "On" : "Off")
                        RoutineSetupNote(routine: r)
                    }
                        .swipeActions(edge: .trailing) {
                            Button("Delete", systemImage: "trash", role: .destructive) { deletingRoutine = r }
                        }
                        .contextMenu {
                            Button("Delete", systemImage: "trash", role: .destructive) { deletingRoutine = r }
                        }
                }
            case .rules:
                Section {
                    Picker("Rules or activity", selection: $showsActivity) {
                        Text("Rules").tag(false)
                        Text("Activity").tag(true)
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .accessibilityIdentifier("rules-tabs")
                    .listRowBackground(Color.clear)
                }
                if showsActivity {
                    ActivityList()
                } else {
                    ForEach(world.rules.filter(match(\.description))) { r in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(r.description ?? "")
                            Text([r.scope?.capitalized, behavior(r.behavior), r.source == "builtin" ? "Built-in" : nil].compactMap { $0 }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            case .skills:
                ForEach(world.skills.filter(match(\.name))) { s in
                    NavigationLink {
                        SkillDetailView(skillId: s.id)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(s.name ?? "").font(.headline)
                                if let version = s.active?.version { Text("v\(version)").font(.caption).foregroundStyle(.secondary) }
                                if s.needsReview { Text("Needs review").font(.caption).foregroundStyle(Theme.warning) }
                            }
                            Text(s.description ?? "").font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                }
            case .memory, .library:
                EmptyView()
            case .usage:
                if let week = world.usage?.week {
                    Section {
                        Gauge(value: week.percent ?? 0) {
                            Text(String(format: "$%.2f of $%.0f this week", week.costUsd ?? 0, week.limitUsd ?? 0))
                        }
                    }
                }
                Section("By agent") {
                    ForEach(world.usage?.byAgent ?? [], id: \.agentId) { u in
                        AgentRow(agent: world.agent(u.agentId), title: world.agent(u.agentId)?.name ?? "", subtitle: "\(u.runs ?? 0) runs", trailing: String(format: "$%.2f", u.costUsd ?? 0))
                    }
                }
            }
        }
        .webGrouped().listRowBackground(Theme.muted)
        .pageHeader(page.rawValue)
        .searchable(text: $query)
        .toolbar {
            if page == .rules && showsActivity { ToolbarItem(placement: .topBarTrailing) { ActivityExportButton() } }
        }
        .confirmationDialog("Delete this schedule? It won't run again.", isPresented: Binding(get: { deletingRoutine != nil }, set: { if !$0 { deletingRoutine = nil } }), titleVisibility: .visible) {
            Button("Delete", role: .destructive) { if let r = deletingRoutine { world.deleteRoutine(r.id) }; deletingRoutine = nil }
            Button("Cancel", role: .cancel) { deletingRoutine = nil }
        }
        }
    }

    private func match<T>(_ key: KeyPath<T, String?>) -> (T) -> Bool {
        { query.isEmpty || ($0[keyPath: key] ?? "").localizedCaseInsensitiveContains(query) }
    }

    private func behavior(_ b: String?) -> String? {
        switch b {
        case "auto": "Allowed without asking"
        case "on_command": "Only when asked"
        case "ask": "Ask me"
        case "handoff": "You do it"
        default: b?.capitalized
        }
    }
}
