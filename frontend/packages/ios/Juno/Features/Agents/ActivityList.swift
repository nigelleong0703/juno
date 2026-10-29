import SwiftUI

/// The Rules page's Activity tab: every decision an agent made under a rule, newest first, with who started the work. A page of 20 at a
/// time ("Show more"), "All · Unattended" (default segmented control) and Export CSV (the share sheet takes the file).
struct ActivityList: View {
    @Environment(World.self) private var world

    var body: some View {
        Section {
            Picker("Show", selection: Binding(get: { world.activity.unattendedOnly }, set: { world.setActivityUnattended($0) })) {
                Text("All").tag(false)
                Text("Unattended").tag(true)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .accessibilityIdentifier("activity-filter")
            .listRowBackground(Color.clear)
        }
        Section {
            if world.activity.failed && world.activity.entries.isEmpty {
                Button("Couldn't load the activity. Try again") { Task { await world.loadActivity() } }
            } else if world.activity.loaded && world.activity.entries.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text(world.activity.unattendedOnly ? "Nothing happened without you" : "Nothing reviewed yet")
                    Text(world.activity.unattendedOnly ? "Work that routines, strangers or the system started shows up here." : "Every decision an agent makes under a rule shows up here.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            ForEach(world.activity.entries) { entry in ActivityRow(entry: entry) }
            if world.activity.next != nil {
                ShowMoreButton(title: "Show more") { Task { await world.loadActivity(more: true) } }
                    .disabled(world.activity.loading)
            }
        }
        .task { if !world.activity.loaded { await world.loadActivity() } }
    }
}

/// Export CSV in the page's toolbar: opens the share sheet with the file for the current filter.
struct ActivityExportButton: View {
    @Environment(World.self) private var world

    var body: some View {
        ShareLink(item: world.activityCSV(), preview: SharePreview("juno-activity.csv")) {
            Label("Export CSV", systemImage: "square.and.arrow.up")
        }
        .accessibilityIdentifier("activity-export")
    }
}

private struct ActivityRow: View {
    @Environment(World.self) private var world
    var entry: AuditEntry

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle().fill(dot).frame(width: 6, height: 6).padding(.top, 6)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.action ?? "")
                Text(entry.reason ?? "").font(.caption).foregroundStyle(.secondary)
                if let initiator = entry.initiator {
                    Text(initiator.startedByLine(routineName: routineName(initiator))).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                Text(auditDecisionLabel(entry.decision)).font(.caption)
                Text(Fmt.ago(entry.at)).font(.caption).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var dot: Color {
        switch entry.decision {
        case "denied": Theme.danger
        case "auto_allowed", "approved": Theme.success
        default: Theme.warning
        }
    }

    private func routineName(_ initiator: Contract.RunOrigin) -> String? {
        guard initiator.type == "routine" else { return nil }
        return world.routines.first { $0.id == initiator.routineId }?.name
    }
}
