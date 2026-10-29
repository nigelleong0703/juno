import SafariServices
import SwiftUI
import UIKit

// MARK: - Space actions (BACKEND §5.12): open in Safari, share as a link. The app itself is never embedded.

/// "Open" / "Wake & open": asks for a fresh link on every tap and shows it in Safari.
struct SpaceOpenButton: View {
    @Environment(World.self) private var world
    var spaceId: String?
    var paused = false
    @State private var opening = false
    @State private var failed = false
    @State private var page: SafariPage?

    var body: some View {
        HStack(spacing: 8) {
            if failed { Text("Could not open. Try again.").text(.xs).foregroundStyle(Theme.fgMuted) }
            Button { Task { await open() } } label: {
                Label(opening ? "Opening…" : paused ? "Wake & open" : "Open", systemImage: "arrow.up.forward.app")
            }
            .buttonStyle(WebButton(variant: paused ? .secondary : .primary, size: .regular))
            .disabled(spaceId == nil || opening)
        }
        .fullScreenCover(item: $page) { SafariView(url: $0.url).ignoresSafeArea() }
    }

    private func open() async {
        guard let spaceId, !opening else { return }
        opening = true; failed = false
        defer { opening = false }
        do { page = SafariPage(url: try await world.spaceOpenURL(spaceId)) } catch { failed = true }
    }
}

struct SafariPage: Identifiable { let id = UUID(); var url: URL }

struct SafariView: UIViewControllerRepresentable {
    var url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController { SFSafariViewController(url: url) }
    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

// MARK: - Share sheet (BACKEND §5.12, option B; web: SpaceShareDialog.tsx)

/// Share a Space as a link: publish a copy, who may open it, whether visitors may change its data, open it as the owner,
/// publish a new version, or stop sharing. `hosted` is the viewer's copy of the server's state; every answer replaces it.
struct SpaceShareSheet: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var spaceId: String
    var name: String
    @Binding var hosted: Contract.SpaceHosted?
    @State private var busy = false
    @State private var error: String?
    @State private var confirmStop = false
    @State private var page: SafariPage?

    private var visibility: Binding<String> {
        Binding(get: { hosted?.visibility ?? "link" }, set: { change(Contract.SpaceHostedUpdate(visibility: $0)) })
    }
    private var visitorWrites: Binding<Bool> {
        Binding(get: { hosted?.visitorWrites ?? false }, set: { change(Contract.SpaceHostedUpdate(visitorWrites: $0)) })
    }

    var body: some View {
        JunoSheet(icon: "link", title: "Share", guidance: guidance, primary: "Done", cancel: "Close",
                  onPrimary: { dismiss() }, onCancel: { dismiss() }) {
            VStack(alignment: .leading, spacing: 18) {
                if let url = hosted?.url {
                    JunoFormField(label: "Link") {
                        HStack(spacing: 8) {
                            Text(url).text(.sm).foregroundStyle(Theme.fgMuted).lineLimit(2).textSelection(.enabled)
                            Spacer(minLength: 0)
                            Button { UIPasteboard.general.string = url } label: { Label("Copy", systemImage: "doc.on.doc") }
                                .buttonStyle(WebButton(variant: .secondary, size: .sm))
                        }
                        .inputField()
                    }
                    JunoFormField(label: "Who can open it", help: Self.access(hosted?.visibility)?.hint) {
                        Picker("Who can open it", selection: visibility) {
                            ForEach(Self.accessOptions) { option in Text(option.label).tag(option.value) }
                        }
                        .pickerStyle(.segmented)
                        .disabled(busy)
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        Toggle("Visitors can change data", isOn: visitorWrites).disabled(busy)
                        Text("Off: people without your sign-in can only read the data.").text(.xs).foregroundStyle(Theme.fgSubtle)
                    }
                    VStack(alignment: .leading, spacing: 10) {
                        Button { Task { await openAsMe() } } label: { Label("Open as me", systemImage: "arrow.up.forward.app") }
                            .buttonStyle(WebButton(variant: .secondary, size: .regular)).disabled(busy)
                        Button { Task { await run { hosted = try await world.publishHosted(spaceId) } } } label: {
                            Label("Publish new version", systemImage: "arrow.clockwise")
                        }
                        .buttonStyle(WebButton(variant: .secondary, size: .regular)).disabled(busy)
                        Button { confirmStop = true } label: { Label("Stop sharing", systemImage: "xmark.circle").foregroundStyle(Theme.danger) }
                            .buttonStyle(WebButton(variant: .ghost, size: .regular)).disabled(busy)
                    }
                } else {
                    Button { Task { await run { hosted = try await world.publishHosted(spaceId) } } } label: { Label("Share link", systemImage: "link") }
                        .buttonStyle(WebButton(variant: .primary, size: .regular)).disabled(busy)
                }
                if let error { JunoMessage(text: error) }
            }
        }
        .fullScreenCover(item: $page) { SafariView(url: $0.url).ignoresSafeArea() }
        .confirmationDialog("Stop sharing this app?", isPresented: $confirmStop, titleVisibility: .visible) {
            Button("Stop sharing", role: .destructive) { Task { await run { try await world.revokeHosted(spaceId); hosted = nil } } }
        } message: {
            Text("The link stops working and its hosted data is deleted. Publishing again creates a new link.")
        }
    }

    private var guidance: String {
        hosted == nil
            ? "Publishing copies this app and its data to a link that keeps working when your computer sleeps."
            : "The app and its data are hosted at this link. Publishing again replaces the hosted copy with what is on your computer now."
    }

    private func change(_ body: Contract.SpaceHostedUpdate) {
        Task { await run { hosted = try await world.updateHosted(spaceId, body) } }
    }

    private func openAsMe() async {
        await run { page = SafariPage(url: try await world.hostedOpenURL(spaceId)) }
    }

    /// One sharing request: shows its failure and clears it on the next attempt. The caller keeps `hosted` current.
    private func run(_ request: () async throws -> Void) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do { try await request() } catch { self.error = sharingMessage(error) }
    }

    private struct Access: Identifiable {
        var value: String
        var label: String
        var hint: String
        var id: String { value }
    }

    private static let accessOptions = [
        Access(value: "link", label: "Link", hint: "Anyone with the link can open it. It is not listed anywhere."),
        Access(value: "public", label: "Public", hint: "Anyone with the link can open it, and search engines may index it."),
        Access(value: "private", label: "Private", hint: "Only you can open it, through Open as me."),
    ]

    private static func access(_ value: String?) -> Access? { accessOptions.first { $0.value == value } }
}

/// The reason a sharing request failed: the server's own message for a 409, a plain line otherwise (web: sharingErrorMessage).
private func sharingMessage(_ error: Error) -> String {
    guard case .api(_, let code, let message)? = error as? APIError else { return "Could not update sharing. Try again." }
    switch code {
    case "HOSTED_UNAVAILABLE": return "Sharing links aren't set up on this server yet"
    case "SPACE_HAS_SERVER_CODE" where !message.isEmpty: return message
    default: return "Could not update sharing. Try again."
    }
}
