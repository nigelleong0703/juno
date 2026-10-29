import SwiftUI

/// Routines page: Calendar | List (the choice is remembered). The list is the existing system list.
struct RoutinesHome: View {
    @AppStorage("automations.view") private var view = "calendar"

    var body: some View {
        VStack(spacing: 0) {
            Picker("View", selection: $view) {
                Text("Calendar").tag("calendar")
                Text("List").tag("list")
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16).padding(.bottom, 8)
            if view == "list" {
                GlobalPageView(page: .routines)
            } else {
                RoutinesCalendar().pageHeader("Routines")
            }
        }
        .background(Theme.canvas)
    }
}

/// One block on the day timeline: a recorded run (past) or a cron fire time (future).
struct RoutineOccurrence: Identifiable, Equatable {
    var routine: Routine
    var start: Date
    var past: Bool
    var status: String?
    var id: String { "\(routine.id)-\(start.timeIntervalSince1970)" }
}

/// One thing on the timeline: a routine occurrence, or an item from an agent's own calendar.
struct DayBlock: Identifiable {
    var start: Date
    var occurrence: RoutineOccurrence?
    var item: Contract.AgentCalendarItem?
    var id: String { occurrence?.id ?? "item-\(item?.id ?? "")" }
}

/// The agents' own calendar for one day: a week strip to pick the day, a 24-hour timeline with one coloured block per
/// occurrence (colour = the agent's character tint), and the routines that have no time under "On demand".
struct RoutinesCalendar: View {
    @Environment(World.self) private var world
    @State private var day = Calendar.current.startOfDay(for: .now)
    @State private var opened: Routine?
    @State private var openedItem: Contract.AgentCalendarItem?
    @State private var onDemandLimit = 3

    private let hourHeight: CGFloat = 56, gutter: CGFloat = 44, blockMinutes = 40, openAtHour = 7
    private var calendar: Calendar { var c = Calendar.current; c.firstWeekday = 2; return c }

    private var routines: [Routine] { world.routines.filter { world.scope == nil || $0.agentId == world.scope } }
    private func timed(_ r: Routine) -> Bool { r.trigger?.kind == "schedule" && CronSchedule(r.trigger?.cron ?? "") != nil }

    /// More than this many fires a day collapses into one "Hourly" chip.
    private let densePerDay = 6

    private func fires(_ routine: Routine, from: Date, to: Date) -> [Date] {
        guard let trigger = routine.trigger, let cron = CronSchedule(trigger.cron ?? "") else { return [] }
        return cron.occurrences(from: from, to: to, in: TimeZone(identifier: trigger.tz ?? "") ?? .current)
    }

    private var dayRange: (Date, Date) { (day, calendar.date(byAdding: .day, value: 1, to: day) ?? day) }

    private var dense: [Routine] {
        routines.filter { timed($0) && fires($0, from: dayRange.0, to: dayRange.1).count > densePerDay }
    }

    private var occurrences: [RoutineOccurrence] {
        let (from, to) = dayRange
        var result: [RoutineOccurrence] = []
        for routine in routines where timed(routine) {
            let times = fires(routine, from: from, to: to)
            if times.count > densePerDay { continue }
            // A skipped entry is a note about occurrences that never ran, not a run that happened at that time.
            for run in routine.history ?? [] where run.status != "skipped" {
                if let start = run.startedAt, start >= from, start < to, start <= .now {
                    result.append(RoutineOccurrence(routine: routine, start: start, past: true, status: run.status))
                }
            }
            for start in times where start > .now { result.append(RoutineOccurrence(routine: routine, start: start, past: false)) }
        }
        return result.sorted { $0.start < $1.start }
    }

    /// The agents' own calendar items on the visible day (cancelled ones are hidden; the agent filter applies).
    private var calendarItemsToday: [Contract.AgentCalendarItem] {
        let (from, to) = dayRange
        return world.calendarItems.filter { item in
            guard let at = item.at, at >= from, at < to, item.status != "cancelled" else { return false }
            return world.scope == nil || item.agentId == world.scope
        }
    }

    private var dayBlocks: [DayBlock] {
        let routineBlocks = occurrences.map { DayBlock(start: $0.start, occurrence: $0, item: nil) }
        let itemBlocks = calendarItemsToday.compactMap { item in item.at.map { DayBlock(start: $0, occurrence: nil, item: item) } }
        return (routineBlocks + itemBlocks).sorted { $0.start < $1.start }
    }

    private func itemTint(_ item: Contract.AgentCalendarItem) -> Color { agentTint(world.agent(item.agentId) ?? Agent(id: item.agentId ?? "")) }

    private func itemSymbol(_ item: Contract.AgentCalendarItem) -> String {
        switch item.kind {
        case "meeting": "video"
        case "task": "checkmark.square"
        default: "person.crop.circle"
        }
    }

    private func tint(_ routine: Routine) -> Color { agentTint(world.agent(routine.agentId) ?? Agent(id: routine.agentId ?? "")) }
    private func minutes(_ date: Date) -> Int { calendar.component(.hour, from: date) * 60 + calendar.component(.minute, from: date) }

    var body: some View {
        let hasTimed = routines.contains(where: timed)
        let onDemand = routines.filter { !timed($0) }
        VStack(spacing: 0) {
            weekStrip
            if !hasTimed && calendarItemsToday.isEmpty {
                ContentUnavailableView("No scheduled automations", systemImage: "calendar", description: Text("Scheduled routines appear here, one colour per agent."))
            } else {
                allDay
                timeline
            }
            if !onDemand.isEmpty { onDemandSection(onDemand) }
        }
        .background(Theme.canvas)
        .sheet(item: $opened) { RoutineSheet(routine: $0) }
        .sheet(item: $openedItem) { CalendarItemSheet(item: $0) }
        .task(id: day) { await world.loadCalendar(from: dayRange.0, to: dayRange.1) }
    }

    // MARK: Week strip

    private var weekStrip: some View {
        let monday = calendar.dateInterval(of: .weekOfYear, for: day)?.start ?? day
        return VStack(spacing: 6) {
            HStack {
                Text(day.formatted(.dateTime.month(.wide).year())).text(.lg, .semibold).foregroundStyle(Theme.fg)
                Spacer()
                Button("Today") { day = calendar.startOfDay(for: .now) }.text(.base, .medium).foregroundStyle(Theme.fg)
                    .disabled(calendar.isDateInToday(day))
            }
            .padding(.horizontal, 16)
            HStack(spacing: 0) {
                Button { shift(-7) } label: { Image(systemName: "chevron.left").frame(width: 28, height: 44) }
                    .accessibilityLabel("Previous week")
                ForEach(0..<7, id: \.self) { offset in
                    let date = calendar.date(byAdding: .day, value: offset, to: monday) ?? monday
                    let selected = calendar.isDate(date, inSameDayAs: day)
                    Button { day = calendar.startOfDay(for: date) } label: {
                        VStack(spacing: 2) {
                            Text(date.formatted(.dateTime.weekday(.narrow))).text(.xs).foregroundStyle(Theme.fgMuted)
                            Text(date.formatted(.dateTime.day())).text(.base, .semibold)
                                .foregroundStyle(selected ? Theme.primaryFg : (calendar.isDateInToday(date) ? Theme.danger : Theme.fg))
                                .frame(width: 32, height: 32)
                                .background(selected ? Theme.primary : .clear, in: .circle)
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(date.formatted(.dateTime.weekday(.wide).day().month(.wide)))
                }
                Button { shift(7) } label: { Image(systemName: "chevron.right").frame(width: 28, height: 44) }
                    .accessibilityLabel("Next week")
            }
            .foregroundStyle(Theme.fgMuted)
            .padding(.horizontal, 8)
        }
        .padding(.bottom, 6)
    }

    private func shift(_ days: Int) { day = calendar.date(byAdding: .day, value: days, to: day) ?? day }

    // MARK: Frequent routines

    @ViewBuilder private var allDay: some View {
        let frequent = dense
        if !frequent.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(frequent) { routine in
                        Button { opened = routine } label: {
                            Text("\(routine.name ?? "") · Hourly").text(.sm, .medium).foregroundStyle(Theme.fg).lineLimit(1)
                                .padding(.horizontal, 10).padding(.vertical, 5)
                                .background(tint(routine).opacity(0.28), in: .capsule)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 16)
            }
            .padding(.bottom, 6)
        }
    }

    // MARK: Timeline

    private var timeline: some View {
        let items = lanes(dayBlocks)
        return ScrollViewReader { proxy in
            ScrollView {
                ZStack(alignment: .topLeading) {
                    VStack(spacing: 0) {
                        ForEach(0..<24, id: \.self) { hour in
                            HStack(alignment: .top, spacing: 6) {
                                Text(hour == 0 ? "" : Calendar.current.date(bySettingHour: hour, minute: 0, second: 0, of: day)!.formatted(.dateTime.hour()))
                                    .text(.xs).foregroundStyle(Theme.fgSubtle).frame(width: gutter, alignment: .trailing).offset(y: -7)
                                Rectangle().fill(Theme.border).frame(height: 0.5)
                            }
                            .frame(height: hourHeight, alignment: .top).id(hour)
                        }
                    }
                    GeometryReader { geo in
                        let width = geo.size.width - gutter - 14
                        ForEach(items, id: \.block.id) { item in
                            Group {
                                if let occurrence = item.block.occurrence { block(occurrence) }
                                else if let calendarItem = item.block.item { itemBlock(calendarItem) }
                            }
                            .frame(width: width / CGFloat(item.lanes) - 2, height: hourHeight * CGFloat(blockMinutes) / 60 - 2, alignment: .topLeading)
                            .offset(x: gutter + 6 + width / CGFloat(item.lanes) * CGFloat(item.lane), y: CGFloat(minutes(item.block.start)) / 60 * hourHeight)
                        }
                        if calendar.isDateInToday(day) {
                            Rectangle().fill(Theme.danger).frame(height: 1)
                                .padding(.leading, gutter)
                                .offset(y: CGFloat(minutes(.now)) / 60 * hourHeight)
                        }
                    }
                    .frame(height: hourHeight * 24)
                }
                .padding(.trailing, 8)
            }
            .onAppear { proxy.scrollTo(openAtHour, anchor: .top) }
            .onChange(of: day) { proxy.scrollTo(openAtHour, anchor: .top) }
        }
    }

    private func lanes(_ items: [DayBlock]) -> [(block: DayBlock, lane: Int, lanes: Int)] {
        var result: [(block: DayBlock, lane: Int, lanes: Int)] = []
        var cluster: [(block: DayBlock, lane: Int, lanes: Int)] = []
        var laneEnds: [Int] = []
        var clusterEnd = -1
        func flush() {
            result += cluster.map { ($0.block, $0.lane, laneEnds.count) }
            cluster = []; laneEnds = []
        }
        for item in items {
            let start = minutes(item.start)
            if start >= clusterEnd { flush() }
            let lane = laneEnds.firstIndex { $0 <= start } ?? laneEnds.count
            if lane == laneEnds.count { laneEnds.append(0) }
            laneEnds[lane] = start + blockMinutes
            clusterEnd = max(clusterEnd, start + blockMinutes)
            cluster.append((item, lane, 1))
        }
        flush()
        return result
    }

    /// An item from the agent's own calendar: dashed agent-tinted block, kind symbol + title; check when done, amber "Missed".
    private func itemBlock(_ item: Contract.AgentCalendarItem) -> some View {
        let missed = item.status == "missed"
        let tint = itemTint(item)
        return Button { openedItem = item } label: {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    Image(systemName: itemSymbol(item)).font(.system(size: 11, weight: .semibold))
                    Text(item.title ?? "").text(.sm, .semibold).lineLimit(1)
                    if item.status == "done" { Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)) }
                }
                Text(missed ? "Missed" : (item.at?.formatted(.dateTime.hour().minute()) ?? "")).text(.xs).foregroundStyle(Theme.fgMuted)
            }
            .foregroundStyle(Theme.fg)
            .padding(.horizontal, 6).padding(.vertical, 3)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(tint.opacity(item.status == "done" ? 0.3 : 0.12), in: .rect(cornerRadius: 6))
            .overlay { RoundedRectangle(cornerRadius: 6).strokeBorder(missed ? Theme.warning : tint, style: StrokeStyle(lineWidth: 1.5, dash: missed ? [] : [4, 3])) }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(item.title ?? ""), \(item.at?.formatted(.dateTime.hour().minute()) ?? "")\(missed ? ", missed" : "")")
    }

    private func block(_ item: RoutineOccurrence) -> some View {
        let routine = item.routine
        let dimmed = !item.past && (!(routine.enabled ?? true) || routine.status == "paused" || routine.needsSetup || routine.status == "error")
        let failed = item.past && item.status == "failed"
        return Button { opened = routine } label: {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    AvatarView(agent: world.agent(routine.agentId) ?? Agent(id: routine.agentId ?? ""), size: 16).frame(width: 16, height: 16)
                    Text(routine.name ?? "").text(.sm, .semibold).lineLimit(1)
                    if item.past && item.status == "completed" { Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)) }
                    if failed { Image(systemName: "exclamationmark.circle.fill").font(.system(size: 10)).foregroundStyle(Theme.danger) }
                }
                Text(item.start.formatted(.dateTime.hour().minute())).text(.xs).foregroundStyle(Theme.fgMuted)
            }
            .foregroundStyle(Theme.fg)
            .padding(.horizontal, 6).padding(.vertical, 3)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(tint(routine).opacity(item.past ? 0.4 : 0.18), in: .rect(cornerRadius: 6))
            .overlay(alignment: .leading) { UnevenRoundedRectangle(topLeadingRadius: 6, bottomLeadingRadius: 6).fill(tint(routine)).frame(width: 3) }
            .overlay { if failed { RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.danger, lineWidth: 1.5) } }
            .opacity(dimmed ? 0.5 : 1)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(routine.name ?? ""), \(item.start.formatted(.dateTime.hour().minute()))\(failed ? ", failed" : "")")
    }

    // MARK: On demand

    private func onDemandSection(_ list: [Routine]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("On demand").text(.sm, .semibold).foregroundStyle(Theme.fgMuted)
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(list.prefix(onDemandLimit)) { routine in
                        Button { opened = routine } label: {
                            HStack(spacing: 8) {
                                Circle().fill(tint(routine)).frame(width: 8, height: 8)
                                Text(routine.name ?? "").text(.base, .medium).foregroundStyle(Theme.fg).lineLimit(1)
                                Text(routine.trigger?.human ?? "").text(.sm).foregroundStyle(Theme.fgSubtle).lineLimit(1)
                                Spacer(minLength: 0)
                            }
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                    }
                    ShowMore(shown: min(onDemandLimit, list.count), total: list.count) { onDemandLimit += 6 }
                }
            }
            .frame(maxHeight: 150)
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgSubtle)
    }
}

/// A routine opened from the calendar: who runs it, when, its state and the on/off switch.
struct RoutineSheet: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var routine: Routine

    var body: some View {
        let live = world.routines.first { $0.id == routine.id } ?? routine
        VStack(alignment: .leading, spacing: 14) {
            AgentRow(agent: world.agent(live.agentId), title: live.name ?? "", subtitle: live.trigger?.human, trailing: live.needsSetup ? "Needs setup" : live.runs ? "On" : "Off")
            if let next = live.nextRunAt { Text("Next run \(next.formatted(.dateTime.weekday().day().month().hour().minute()))").text(.base).foregroundStyle(Theme.fgMuted) }
            if let last = live.lastRunAt {
                Text("Last run \(last.formatted(.dateTime.weekday().day().month().hour().minute()))\(live.lastRunStatus == "failed" ? " · failed" : "")").text(.base).foregroundStyle(Theme.fgMuted)
            }
            Toggle("Enabled", isOn: Binding(get: { live.runs }, set: { _ in world.toggleRoutine(live.id) }))
                .tint(Theme.success).disabled(live.needsSetup)
            RoutineSetupNote(routine: live)
            history(live)
            Spacer(minLength: 0)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.canvas)
        .presentationDetents([.medium])
    }

    /// The last few runs. What was skipped while the server was offline is a quiet entry in the server's words
    /// ("Skipped: missed while offline (3 runs, …)"), not a run that happened.
    @ViewBuilder private func history(_ routine: Routine) -> some View {
        let entries = Array((routine.history ?? []).prefix(5))
        if !entries.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("History").text(.md, .semibold).foregroundStyle(Theme.fg)
                ForEach(entries) { run in
                    HStack(spacing: 10) {
                        Circle().fill(RoutineRunWords.color(run.status)).frame(width: 6, height: 6)
                        Text(run.summary ?? "").text(.base).foregroundStyle(run.status == "skipped" ? Theme.fgMuted : Theme.fg).lineLimit(2)
                        Spacer(minLength: 8)
                        if let start = run.startedAt { Text(Fmt.ago(start)).text(.sm).foregroundStyle(Theme.fgSubtle) }
                    }
                    .accessibilityIdentifier("routine-run-\(run.id)")
                }
            }
        }
    }
}

enum RoutineRunWords {
    /// The dot in front of a history entry: skipped is neither success nor failure.
    static func color(_ status: String?) -> Color {
        switch status {
        case "failed": Theme.danger
        case "running": Theme.fg
        case "skipped": Theme.fgSubtle
        default: Theme.success
        }
    }
}
