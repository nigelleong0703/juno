import SwiftUI

/// Settings → iPhone access: what Juno may do on this iPhone for your agents, one switch per part of the phone. Every switch is
/// off until you turn it on, and turning it on is the only moment iOS is asked for permission. Agents can use these only while
/// this app is open (nothing wakes the phone), and they ask you before they add, change, send or delete anything.
struct PhoneAccessView: View {
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    private let device = PhoneDevice.shared

    var body: some View {
        let _ = device.switches
        List {
            Section {
                ForEach(PhoneCapability.allCases) { capability in row(capability) }
            } footer: {
                Text("Your agents can use these only while Juno is open on this iPhone. Nothing is on until you turn it on, and they ask you first before they add, change, send or delete anything. Siri and Shortcuts can also message an agent: look for Ask Juno in the Shortcuts app.")
            }
            .listRowBackground(Theme.muted)
        }
        .webGrouped()
        .pageHeader("iPhone access")
        .onAppear { device.refreshAccess() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { device.refreshAccess() } }
    }

    @ViewBuilder private func row(_ capability: PhoneCapability) -> some View {
        let access = device.access[capability] ?? .notAsked
        let label = Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(capability.title).foregroundStyle(Theme.fg)
                Text(subtitle(capability, access: access, on: device.isOn(capability)))
                    .text(.sm).foregroundStyle(Theme.fgMuted).fixedSize(horizontal: false, vertical: true)
            }
        } icon: {
            Image(systemName: capability.systemImage).foregroundStyle(Theme.fgMuted)
        }
        if access == .denied {
            HStack {
                label
                Spacer()
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                }
                .accessibilityIdentifier("phone-access-settings-\(capability.rawValue)")
            }
        } else {
            Toggle(isOn: Binding(get: { device.isOn(capability) }, set: { device.setOn(capability, $0) })) { label }
                .tint(Theme.success)
                .disabled(access == .unavailable)
                .accessibilityIdentifier("phone-access-\(capability.rawValue)")
            // Photos shared with Juno are the ones the owner picked: this is where the picking is changed.
            if capability == .photos, access == .limited, device.isOn(capability) {
                Button("Choose photos to share") { PhotosSystem.chooseMore() }
                    .accessibilityIdentifier("phone-access-photos-choose")
            }
        }
    }

    private func subtitle(_ capability: PhoneCapability, access: PhoneAccess, on: Bool) -> String {
        switch access {
        case .unavailable: return "Not available on this iPhone."
        case .denied: return "Off in iPhone Settings. Allow Juno there to use this."
        default: break
        }
        guard on else { return capability.blurb }
        switch access {
        case .writeOnly: return "On · can add events but not read them"
        case .limited: return "On · only what you picked"
        default: return "On"
        }
    }
}
