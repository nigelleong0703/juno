import SwiftUI

/// One item from an agent's own calendar, opened from the routines calendar: what it is, when, with whom, how it went, and Cancel.
struct CalendarItemSheet: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var item: Contract.AgentCalendarItem
    @State private var confirming = false

    private var kindLabel: String {
        switch item.kind {
        case "meeting": "Meeting"
        case "task": "Task"
        default: "Follow-up"
        }
    }

    private var symbol: String {
        switch item.kind {
        case "meeting": "video"
        case "task": "checkmark.square"
        default: "person.crop.circle"
        }
    }

    private var statusLabel: String {
        switch item.status {
        case "done": "Done"
        case "missed": "Missed"
        case "cancelled": "Cancelled"
        default: "Scheduled"
        }
    }

    var body: some View {
        let live = world.calendarItems.first { $0.id == item.id } ?? item
        VStack(alignment: .leading, spacing: 14) {
            AgentRow(agent: world.agent(live.agentId), title: live.title ?? "", subtitle: kindLabel, trailing: statusLabel)
            if let at = live.at {
                Label(at.formatted(.dateTime.weekday().day().month().hour().minute()), systemImage: symbol)
                    .text(.base).foregroundStyle(Theme.fgMuted)
            }
            if let name = live.withWhom?.name { Text("With \(name)").text(.base).foregroundStyle(Theme.fgMuted) }
            if let instructions = live.instructions, !instructions.isEmpty { Text(instructions).text(.base).foregroundStyle(Theme.fg) }
            if let result = live.result, !result.isEmpty { Text(result).text(.base).foregroundStyle(Theme.fgMuted) }
            Spacer(minLength: 0)
            if live.status == "scheduled" {
                Button("Cancel item", role: .destructive) { confirming = true }
                    .frame(maxWidth: .infinity)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.canvas)
        .presentationDetents([.medium])
        .confirmationDialog("Cancel this item?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Cancel item", role: .destructive) {
                world.cancelCalendarItem(item.id)
                dismiss()
            }
            Button("Keep", role: .cancel) {}
        } message: {
            Text("The agent will not do it.")
        }
    }
}
