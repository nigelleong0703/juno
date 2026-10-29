import SwiftUI

// MARK: - Goals (Muse's goals card: Tracking / Goals; Later today at the end)

/// The seven categories the web offers (POST /v1/goals `category`).
enum GoalCategory: String, CaseIterable, Identifiable {
    case health, relationships, finance, career, interests, productivity, other
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
}

struct GoalsPage: View {
    @Environment(World.self) private var world
    @State private var creating = UserDefaults.standard.bool(forKey: "create-goal")
    @State private var done: Set<String> = []
    @State private var trackingLimit = 8
    @State private var goalsLimit = 8
    @State private var laterLimit = 8

    var body: some View {
        let goals = world.goals.filter { world.scope == nil || $0.agentId == world.scope }
        let end = Calendar.current.startOfDay(for: Date()).addingTimeInterval(86_400)
        let later = world.routines.filter { $0.enabled == true && ($0.nextRunAt ?? .distantFuture) < end && (world.scope == nil || $0.agentId == world.scope) }
            .sorted { ($0.nextRunAt ?? .distantFuture) < ($1.nextRunAt ?? .distantFuture) }

        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack {
                    TabHeading(title: "Goals")
                    Spacer()
                    Button { creating = true } label: {
                        Label("Create goal", systemImage: "plus")
                    }
                    .buttonStyle(.glass).tint(Theme.fg)
                    .disabled(world.agents.isEmpty)
                }

                if goals.isEmpty && later.isEmpty {
                    ContentUnavailableView("No goals yet", systemImage: "checkmark.square",
                                           description: Text("Create one, or ask an agent to track something for you."))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }

                VStack(alignment: .leading, spacing: 24) {
                    group("Tracking", goals.filter { $0.kind == "tracking" }, limit: trackingLimit) { trackingLimit += 8 }
                    group("Goals", goals.filter { $0.kind == "goal" }, limit: goalsLimit) { goalsLimit += 8 }
                    if !later.isEmpty {
                        PageSection("Later today") {
                            VStack(spacing: 0) {
                                ForEach(Array(later.prefix(laterLimit).enumerated()), id: \.element.id) { index, routine in
                                    HStack(spacing: 12) {
                                        AvatarView(agent: world.agent(routine.agentId), size: 32)
                                        Text(routine.name ?? "").text(.base).foregroundStyle(Theme.fg).lineLimit(1)
                                        Spacer(minLength: 8)
                                        Text(Fmt.time(routine.nextRunAt)).text(.sm).foregroundStyle(Theme.fgMuted)
                                    }
                                    .frame(minHeight: 48)
                                    if index < min(laterLimit, later.count) - 1 { Divider() }
                                }
                            }
                            ShowMore(shown: min(laterLimit, later.count), total: later.count) { laterLimit += 8 }
                        }
                    }
                }
            }
            .frame(maxWidth: 640, alignment: .leading)
            .padding(.horizontal, 16).padding(.top, 0).padding(.bottom, 32)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.canvas)
        .tabHeader("Goals")
        .sheet(isPresented: $creating) { CreateGoalSheet() }
        .onChange(of: world.scope) { _, _ in
            trackingLimit = 8
            goalsLimit = 8
            laterLimit = 8
        }
    }

    @ViewBuilder private func group(_ title: String, _ goals: [PlannedGoal], limit: Int, more: @escaping () -> Void) -> some View {
        if !goals.isEmpty {
            PageSection(title) {
                VStack(spacing: 0) {
                    ForEach(Array(goals.prefix(limit).enumerated()), id: \.element.id) { index, goal in
                        HStack(spacing: 8) {
                            Button {
                                if done.contains(goal.id) { done.remove(goal.id) } else { done.insert(goal.id) }
                            } label: {
                                Image(systemName: done.contains(goal.id) ? "checkmark.square.fill" : "square")
                                    .font(.system(size: 19)).foregroundStyle(Theme.fgMuted)
                                    .frame(width: 44, height: 48).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Mark \(goal.title ?? "goal") \(done.contains(goal.id) ? "incomplete" : "complete")")

                            RouteLink(route: .goal(goal.id)) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(goal.title ?? "").text(.base, .medium).foregroundStyle(Theme.fg)
                                        .strikethrough(done.contains(goal.id)).lineLimit(1)
                                    if let summary = goal.summary, !summary.isEmpty {
                                        Text(summary).text(.sm).foregroundStyle(Theme.fgMuted).lineLimit(2)
                                    }
                                    if let plan = goal.milestones, !plan.isEmpty {
                                        let doing = plan.filter { $0.status == "doing" }.count
                                        Text("\(plan.filter { $0.status == "done" }.count)/\(plan.count) milestones" + (doing > 0 ? " · \(doing) in progress" : "")).text(.xs).foregroundStyle(Theme.fgSubtle)
                                    }
                                    if let category = goal.category, !category.isEmpty {
                                        Text(category.capitalized).text(.xs).foregroundStyle(Theme.fgSubtle)
                                    }
                                }
                                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                            }
                            .buttonStyle(.plain)
                            .contextMenu {
                                Button("Discuss in chat", systemImage: "bubble.left") {
                                    world.openChat(world.directConversation(for: goal.agentId ?? "")?.id, draft: "About “\(goal.title ?? "")”: ")
                                }
                                .disabled(world.directConversation(for: goal.agentId ?? "") == nil)
                            }
                        }
                        if index < min(limit, goals.count) - 1 { Divider().padding(.leading, 44) }
                    }
                }
                ShowMore(shown: min(limit, goals.count), total: goals.count, more: more)
            }
        }
    }
}

/// "+ Create goal": kind, title, one line, category, and which agent tracks it.
struct CreateGoalSheet: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    @State private var kind = "goal"
    @State private var title = ""
    @State private var summary = ""
    @State private var category = GoalCategory.other
    @State private var agentId: String?

    var body: some View {
        let ready = !title.trimmingCharacters(in: .whitespaces).isEmpty && agentId != nil
        JunoSheet(icon: "target", title: "New goal", guidance: kind == "goal" ? "A longer aim the agent works on in steps." : "A concrete watch, such as a date or a price.",
                  primary: "Create", primaryEnabled: ready, long: true, id: "goal", onPrimary: create, onCancel: { dismiss() }) {
            JunoFormField(label: "Kind") {
                Picker("Kind", selection: $kind) {
                    Text("Goal").tag("goal")
                    Text("Tracking").tag("tracking")
                }
                .pickerStyle(.segmented).labelsHidden()
            }
            JunoFormField(label: "Title") {
                TextField("Title", text: $title).inputField()
            }
            JunoFormField(label: "Where it stands", optional: true) {
                TextField("Where it stands", text: $summary, axis: .vertical).lineLimit(1...5).padding(.vertical, 12).inputField()
            }
            JunoFormField(label: "Category") {
                JunoPickerRow(value: category.label, options: GoalCategory.allCases.map(\.label)) { picked in
                    if let match = GoalCategory.allCases.first(where: { $0.label == picked }) { category = match }
                }
            }
            JunoFormField(label: "Agent") {
                JunoPickerRow(value: world.agent(agentId)?.name ?? "", options: world.agents.map { $0.name ?? "" }) { picked in
                    if let match = world.agents.first(where: { ($0.name ?? "") == picked }) { agentId = match.id }
                }
            }
        }
        .onAppear { agentId = world.scope ?? world.agents.first?.id }
    }

    private func create() {
        guard let agentId else { return }
        world.createGoal(agentId: agentId, kind: kind, title: title.trimmingCharacters(in: .whitespaces),
                         summary: summary.trimmingCharacters(in: .whitespaces), category: category.rawValue)
        dismiss()
    }
}

/// Goal detail: where it stands, the agent's plan (milestones), when it checks in next, and the activity timeline
/// (GET /v1/goals/:id). Pause/resume and "Check now" act on the schedule; runs link to their task.
struct GoalDetailView: View {
    @Environment(World.self) private var world
    var goalId: String
    @State private var milestoneLimit = 8
    @State private var activityLimit = 10
    @State private var checkRequested = false

    var body: some View {
        let goal = world.goals.first { $0.id == goalId }
        let allActivity = goal?.activity ?? []
        let activity = allActivity.filter { !($0.kind == "quote" && $0.milestoneId != nil) }
        let milestones = goal?.milestones ?? []
        let active = goal?.status == "active"
        Form {
            Section {
                info("Kind", goal?.kind == "tracking" ? "Tracking" : "Goal")
                info("Category", goal?.category?.capitalized)
                info("Agent", world.agent(goal?.agentId)?.name)
                info("Status", goal?.status?.capitalized)
                if let summary = goal?.summary, !summary.isEmpty {
                    Text(summary)
                }
            }
            .listRowBackground(Theme.muted)

            if goal?.status == "active" || goal?.status == "paused" {
                Section {
                    if active {
                        Button(checkRequested ? "Check-in requested" : "Check now", systemImage: "arrow.clockwise") {
                            checkRequested = true
                            world.checkGoal(goalId)
                        }
                        .disabled(checkRequested)
                    }
                    Button(active ? "Pause" : "Resume", systemImage: active ? "pause" : "play") {
                        world.setGoalStatus(goalId, active ? "paused" : "active")
                        checkRequested = false
                    }
                } footer: {
                    if active, let next = goal?.nextCheckAt {
                        Text("Next check-in \(Fmt.ago(next))" + (goal?.lastCheckedAt.map { ", last checked \(Fmt.ago($0))" } ?? ""))
                    }
                }
                .listRowBackground(Theme.muted)
            }

            Section("Plan") {
                if milestones.isEmpty {
                    Text(active ? "Your agent is writing the plan." : "No plan yet.").foregroundStyle(.secondary)
                }
                ForEach(milestones.prefix(milestoneLimit)) { milestone in
                    MilestoneRow(milestone: milestone, quotes: allActivity.filter { $0.kind == "quote" && $0.milestoneId == milestone.id }.compactMap(\.text))
                }
                if milestones.count > milestoneLimit {
                    Button("Show more (\(milestones.count - milestoneLimit))") { milestoneLimit += 8 }
                }
            }
            .listRowBackground(Theme.muted)

            Section("Activity") {
                if activity.isEmpty {
                    Text("Nothing recorded yet.").foregroundStyle(.secondary)
                }
                ForEach(Array(activity.prefix(activityLimit).enumerated()), id: \.offset) { _, entry in
                    ActivityEntryRow(entry: entry, agentName: world.agent(goal?.agentId)?.name ?? "Agent")
                }
                if activity.count > activityLimit {
                    Button("Show more (\(activity.count - activityLimit))") { activityLimit += 10 }
                }
            }
            .listRowBackground(Theme.muted)
        }
        .webGrouped()
        .pageHeader(goal?.title ?? "Goal")
        .task { world.loadGoal(goalId) }
    }
}

/// One milestone: a status glyph, the title and, when set, its due date.
struct MilestoneRow: View {
    var milestone: GoalMilestone
    var quotes: [String] = []

    private var glyph: (name: String, color: Color) {
        switch milestone.status {
        case "done": ("checkmark.circle.fill", Theme.fgMuted)
        case "doing": ("circle.lefthalf.filled", Theme.fg)
        case "blocked": ("exclamationmark.circle", Theme.fg)
        default: ("circle", Theme.fgSubtle)
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: glyph.name).foregroundStyle(glyph.color).padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                Text(milestone.title ?? "").strikethrough(milestone.status == "done")
                    .foregroundStyle(milestone.status == "done" ? Theme.fgMuted : Theme.fg)
                let state = milestone.status == "blocked" ? "Blocked" : milestone.status == "doing" ? "In progress" : nil
                let due = milestone.due.map { "Due \($0.formatted(date: .abbreviated, time: .omitted))" }
                let line = [state, due].compactMap { $0 }.joined(separator: " · ")
                if !line.isEmpty { Text(line).text(.xs).foregroundStyle(Theme.fgSubtle) }
                if !quotes.isEmpty {
                    DisclosureGroup(quotes.count == 1 ? "1 quote" : "\(quotes.count) quotes") {
                        ForEach(Array(quotes.enumerated()), id: \.offset) { _, quote in
                            Text(quote).text(.xs).foregroundStyle(Theme.fgMuted)
                        }
                    }
                    .text(.xs).foregroundStyle(Theme.fgSubtle)
                }
            }
        }
        .accessibilityElement(children: .contain)
    }
}

struct ActivityEntryRow: View {
    var entry: GoalActivity
    var agentName: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(entry.text ?? "")
            HStack(spacing: 6) {
                Text(entry.actor == "agent" ? agentName : "You")
                Text("·")
                Text(Fmt.ago(entry.at))
                if let runId = entry.runId {
                    Text("·")
                    RouteLink(route: .run(runId)) { Text("Task") }
                }
            }
            .font(.caption).foregroundStyle(.secondary)
        }
    }
}
