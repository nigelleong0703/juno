import SwiftUI

/// Needs a routine can declare that are not apps the owner adds: named by label only. `mac` is the owner's Mac, a
/// virtual capability with its own row (`MacAccessRow`), not an app.
private let notConnectable: Set<String> = ["web_search", "computer", "mac"]

/// The options of a missing requirement the owner can actually connect.
func connectableIds(_ options: [String]?) -> [String] { (options ?? []).filter { !notConnectable.contains($0) } }

/// "Stop" for the paired Mac: every agent loses the Mac right away (the Mac cancels what is running). Once stopped it reads
/// "Stopped · resume on your Mac" and offers nothing: only the Mac itself resumes, never the phone.
struct MacStopLine: View {
    @Environment(World.self) private var world
    @State private var busy = false
    @State private var failure: String?

    var body: some View {
        if world.myMac?.stopped != nil {
            Text("Stopped \u{00B7} resume on your Mac").text(.sm).foregroundStyle(Theme.warning)
                .frame(maxWidth: .infinity, alignment: .leading).accessibilityIdentifier("mac-stopped")
        } else {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 12) {
                    Text("Stops every agent on this Mac right away.").text(.sm).foregroundStyle(Theme.fgMuted)
                    Spacer(minLength: 8)
                    Button("Stop") {
                        busy = true; failure = nil
                        Task { @MainActor in
                            defer { busy = false }
                            do { try await world.stopMyMac() } catch where !error.isCancellation { failure = error.localizedDescription } catch {}
                        }
                    }
                    .buttonStyle(WebButton(variant: .secondary, size: .xs)).disabled(busy).accessibilityIdentifier("mac-stop")
                }
                if let failure { Text(failure).text(.sm).foregroundStyle(Theme.danger) }
            }
        }
    }
}

/// The app id `mac`: the owner's Mac as a capability for one agent. The iPhone cannot pair a Mac, so an unpaired one only
/// says where to do it; a paired one is allowed per agent, and an allowed but offline one says to open Juno on it.
struct MacAccessRow: View {
    @Environment(World.self) private var world
    var agentId: String?
    /// The card's full-width button; otherwise the compact pill.
    var large = false
    /// Whether the line naming what the Mac offers shows (the connect card has it beside the icon already).
    var describes = true

    var body: some View {
        let mac = world.myMac
        let name = world.agent(agentId)?.name ?? "this agent"
        VStack(alignment: .leading, spacing: 6) {
            if describes {
                Text("Your Mac \u{2014} Mail, Calendar and Reminders. macOS will ask once to allow them.").text(.sm).foregroundStyle(Theme.fgMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if mac?.paired != true {
                Text("Open Juno on your Mac to pair").text(.sm).foregroundStyle(Theme.fgMuted)
            } else if let agentId, !world.canUseMac(agentId) {
                let title = "Allow \(name) to use your Mac"
                if large { CardPrimaryButton(title: title, id: "connect-mac") { world.setMacAccess(agentId, true) } }
                else {
                    Button { world.setMacAccess(agentId, true) } label: { Text(title) }
                        .buttonStyle(WebButton(variant: .secondary, size: .xs)).accessibilityIdentifier("connect-mac")
                }
            } else if mac?.stopped != nil {
                Text("Stopped \u{00B7} resume on your Mac").text(.sm).foregroundStyle(Theme.warning)
            } else if mac?.online != true {
                Text("Your Mac is offline. Open Juno on it.").text(.sm).foregroundStyle(Theme.warning)
            } else {
                Label("Connected", systemImage: "checkmark").text(.sm).foregroundStyle(Theme.fgMuted)
            }
        }
        .task { await world.refreshMyMac() }
    }
}

/// "Connect <app>" for an app id: starts the install (its sign-in, its values form, its platform) like the Connect button on the
/// app's page. A routine row's compact pill; with `large`, the card's full-width primary button.
struct AppConnectButton: View {
    @Environment(World.self) private var world
    var appId: String
    var large = false
    /// Replaces "Connect <app>" where the app is already named beside the button.
    var label: String?
    @State private var installer = AppInstaller()

    private var app: Contract.App? { world.app(appId) }
    private var title: String { label ?? "Connect \(app?.displayName ?? appId)" }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if large {
                CardPrimaryButton(title: title, enabled: app?.available != false, loading: installer.busy, id: "connect-\(appId)", action: start)
            } else {
                Button(action: start) { Text(title) }
                    .buttonStyle(WebButton(variant: .secondary, size: .xs))
                    .disabled(installer.busy || app?.available == false)
                    .accessibilityIdentifier("connect-\(appId)")
            }
            if let line = installer.error { Text(line).text(.xs).foregroundStyle(Theme.danger) }
        }
        .task { if world.apps == nil { await world.refreshApps() } }
        .appInstaller(installer)
    }

    private func start() {
        if let app { installer.start(app) } else { world.pendingRoute = .app(appId) }
    }
}

/// Under a routine that cannot run yet: "Needs setup: connect <label>" and a Connect pill per app that would satisfy it.
/// Nothing for a routine that is set up.
struct RoutineSetupNote: View {
    var routine: Routine

    var body: some View {
        if routine.needsSetup, let missing = routine.missing, !missing.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(missing.enumerated()), id: \.offset) { _, need in
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Needs setup: connect \(need.label ?? "")").text(.base).foregroundStyle(Theme.warning)
                            .fixedSize(horizontal: false, vertical: true)
                        HStack(spacing: 8) {
                            ForEach(connectableIds(need.options), id: \.self) { AppConnectButton(appId: $0) }
                            if need.options?.contains("mac") == true { MacAccessRow(agentId: routine.agentId, describes: false) }
                        }
                    }
                }
            }
        }
    }
}

extension Routine {
    /// A routine waiting on an app does not run, whatever its enabled flag says.
    var needsSetup: Bool { status == "needs_setup" }
    var runs: Bool { enabled == true && !needsSetup }
}
