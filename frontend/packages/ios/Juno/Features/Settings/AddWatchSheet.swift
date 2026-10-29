import SwiftUI

/// Settings → Add Apple Watch: type the 8-character code the watch shows, check it with the server, then allow or deny
/// the watch to sign in as this account. Nothing is approved before the server has claimed the code.
struct AddWatchSheet: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    /// The normalised code the server accepted, waiting for Allow or Deny; nil while the user is still typing it.
    @State private var claimed: String?
    @State private var connected = false
    @State private var busy = false
    @State private var message: String?

    /// The code as the server wants it: no dashes or spaces, upper case.
    static func normalized(_ text: String) -> String {
        text.filter { !$0.isWhitespace && $0 != "-" }.uppercased()
    }

    private var ready: Bool { Self.normalized(code).count == 8 }

    private var guidance: String {
        if connected { return "Watch connected. It can now sign in as \(world.session?.name ?? "you")." }
        if claimed != nil { return "Allow this watch to sign in as \(world.session?.name ?? "you")?" }
        return "Open the pairing screen on your watch and type the 8-character code it shows."
    }

    var body: some View {
        JunoSheet(icon: "applewatch", title: "Add Apple Watch", guidance: guidance,
                  primary: connected ? "Done" : claimed == nil ? "Continue" : "Allow",
                  primaryEnabled: connected || claimed != nil || ready,
                  loading: busy, id: "watch", onPrimary: { Task { await primary() } }, onCancel: { dismiss() }) {
            if let message { JunoMessage(text: message, id: "watch-message") }
            if claimed == nil && !connected {
                JunoFormField(label: "Code on your watch", help: "The dashes do not matter.") {
                    TextField("ABCD-1234", text: Binding(get: { code }, set: { code = $0; message = nil }))
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .inputField()
                        .accessibilityIdentifier("watch-field-code")
                }
                .disabled(busy)
            }
            if claimed != nil {
                Button("Deny", role: .destructive) { Task { await deny() } }
                    .buttonStyle(.bordered)
                    .disabled(busy)
                    .accessibilityIdentifier("watch-deny")
            }
        }
    }

    /// Continue checks the code; Allow approves the claimed one; Done closes after success.
    private func primary() async {
        if connected { dismiss(); return }
        if let claimed {
            await run { api in
                try await api.approveWatch(claimed)
                connected = true
            }
        } else {
            let normalized = Self.normalized(code)
            await run { api in
                try await api.claimWatch(normalized)
                claimed = normalized
            }
        }
    }

    private func deny() async {
        guard let claimed else { return }
        await run { api in
            try await api.denyWatch(claimed)
            dismiss()
        }
    }

    private func run(_ work: (API) async throws -> Void) async {
        guard let api = world.api else { message = APIError.notSignedIn.localizedDescription; return }
        busy = true; message = nil
        defer { busy = false }
        do { try await work(api) }
        catch { message = error.localizedDescription }
    }
}
