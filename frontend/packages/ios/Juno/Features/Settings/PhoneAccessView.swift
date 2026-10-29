import SwiftUI

/// Settings → Calendar and reminders: whether Juno may use this iPhone's calendar and reminders for your agents. They can only
/// use them while this app is open (nothing wakes the phone), and they ask you before they add, change or delete anything.
struct PhoneAccessView: View {
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    private let device = PhoneDevice.shared

    var body: some View {
        List {
            Section {
                row("Calendar", systemImage: "calendar", access: device.calendarAccess, request: device.requestCalendar)
                row("Reminders", systemImage: "checklist", access: device.remindersAccess, request: device.requestReminders)
            } footer: {
                Text("Your agents can look at and change these only while Juno is open on this iPhone. They ask you first before they add, change or delete anything.")
            }
            .listRowBackground(Theme.muted)
        }
        .webGrouped()
        .pageHeader("Calendar and reminders")
        .onAppear { device.refreshAccess() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { device.refreshAccess() } }
    }

    private func row(_ title: String, systemImage: String, access: PhoneAccess, request: @escaping () -> Void) -> some View {
        HStack {
            Label(title, systemImage: systemImage).foregroundStyle(Theme.fg)
            Spacer()
            switch access {
            case .full:
                Text("Allowed").text(.sm).foregroundStyle(Theme.fgMuted)
            case .writeOnly:
                // The system lets an app add events without reading any; agents can then add, not look.
                Text("Add only").text(.sm).foregroundStyle(Theme.fgMuted)
            case .notAsked:
                Button("Allow", action: request).accessibilityIdentifier("phone-allow-\(title.lowercased())")
            case .denied:
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                }
            }
        }
        .accessibilityElement(children: .contain)
    }
}
