import SwiftUI

/// The values being edited in the "Your details" sheet: the key, the value (an address may span lines) and who may use it.
struct ProfileDraft: Equatable {
    var key = ""
    var value = ""
    var shared = false

    var trimmedKey: String { key.trimmingCharacters(in: .whitespacesAndNewlines) }
    var trimmedValue: String { value.trimmingCharacters(in: .whitespacesAndNewlines) }
}

/// One sheet to add or edit a detail: name, value, and the "Only me / Shared" control with its one-line explanation.
/// `onSave` throws the server's message (for example a refused secret) to show inline.
struct ProfileEntrySheet: View {
    @Environment(\.dismiss) private var dismiss
    var title: String
    var onSave: (ProfileDraft) async throws -> Void
    @State var draft: ProfileDraft
    @State private var busy = false
    @State private var message: String?

    static let visibilityHelp = "Only me: your agents use it only when working just for you. Shared: also when they serve other people (group chats, Slack)."

    private var ready: Bool { !draft.trimmedKey.isEmpty && !draft.trimmedValue.isEmpty && draft.trimmedKey.count <= 60 && draft.trimmedValue.count <= 2000 }

    var body: some View {
        JunoSheet(icon: "person.text.rectangle", title: title, primary: "Save", primaryEnabled: ready && !busy, loading: busy,
                  long: true, id: "profile", onPrimary: { Task { await save() } }, onCancel: { dismiss() }) {
            if let message { JunoMessage(text: message, id: "profile-message") }
            JunoFormField(label: "Name", counter: (draft.key.count, 60)) {
                TextField("Work email, Home address, KrisFlyer number…", text: Binding(get: { draft.key }, set: { draft.key = $0; message = nil }))
                    .textInputAutocapitalization(.sentences)
                    .autocorrectionDisabled()
                    .inputField()
                    .accessibilityIdentifier("profile-field-key")
            }
            .disabled(busy)
            JunoFormField(label: "Value", help: "An address can span several lines.", counter: (draft.value.count, 2000)) {
                TextField("", text: Binding(get: { draft.value }, set: { draft.value = $0; message = nil }), axis: .vertical)
                    .lineLimit(3...8)
                    .autocorrectionDisabled()
                    .inputField()
                    .accessibilityIdentifier("profile-field-value")
            }
            .disabled(busy)
            JunoFormField(label: "Who can use this", help: Self.visibilityHelp) {
                Picker("Who can use this", selection: $draft.shared) {
                    Text("Only me").tag(false)
                    Text("Shared").tag(true)
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("profile-visibility")
            }
        }
    }

    private func save() async {
        busy = true; message = nil
        defer { busy = false }
        do {
            try await onSave(draft)
            dismiss()
        } catch { message = error.localizedDescription }
    }
}
