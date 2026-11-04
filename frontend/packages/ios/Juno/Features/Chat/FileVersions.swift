import SwiftUI

// File versions (BACKEND 5.2d): when an agent overwrites a file the old version is kept. A step that wrote or edited a file
// offers "Versions" in its detail; the sheet lists them newest first and puts one back after a confirm. Nothing shows for a
// file with no kept versions.

extension StepText {
    /// The file a finished `files.write` / `files.edit` step changed: its path and the computer it was on.
    static func changedFile(_ step: Step) -> (path: String, on: String)? {
        guard ["files.write", "files.edit"].contains(tool(step)), !["failed", "running", "pending"].contains(step.status ?? "") else { return nil }
        let input = args(step)
        guard let path = input["path"] as? String, !path.isEmpty else { return nil }
        return (path, (input["on"] as? String) == "mac" ? "mac" : "sandbox")
    }
}

/// The "Versions" button in a step's detail. It looks the history up when the detail opens and stays out of the way when there is none.
struct FileVersionsEntry: View {
    @Environment(World.self) private var world
    var step: Step
    @State private var versions: [Contract.FileSnapshot] = []
    @State private var showing = false

    var body: some View {
        let file = StepText.changedFile(step)
        let agentId = world.agentId(ofStep: step)
        Group {
            if let file, let agentId, !versions.isEmpty {
                Button { showing = true } label: { Label("Versions", systemImage: "clock.arrow.circlepath") }
                    .buttonStyle(WebButton(variant: .secondary, size: .xs))
                    .accessibilityIdentifier("file-versions")
                    .sheet(isPresented: $showing) {
                        FileVersionsSheet(path: file.path, on: file.on, agentId: agentId, versions: $versions)
                    }
            }
        }
        .task(id: step.id) {
            guard let file, let agentId else { return }
            versions = (try? await world.fileVersions(path: file.path, agentId: agentId, on: file.on)) ?? []
        }
    }
}

struct FileVersionsSheet: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var path: String
    var on: String
    var agentId: String
    @Binding var versions: [Contract.FileSnapshot]
    @State private var shown = 5
    @State private var confirming: Contract.FileSnapshot?
    @State private var restored = false
    @State private var failed = false

    var body: some View {
        JunoSheet(icon: "clock.arrow.circlepath", title: "Versions", guidance: path.split(separator: "/").last.map(String.init), id: "file-versions", onCancel: { dismiss() }) {
            if restored { JunoNote(text: "Restored. The version it replaced is in the list.", icon: "checkmark") }
            if failed { JunoMessage(text: "Couldn't restore this version. Nothing changed.", id: "file-versions-error") }
            VStack(spacing: 0) {
                ForEach(Array(versions.prefix(shown).enumerated()), id: \.element.id) { index, version in
                    if index > 0 { Divider() }
                    row(version)
                }
            }
            ShowMore(shown: min(shown, versions.count), total: versions.count) { withAnimation { shown += 5 } }
        }
        .alert("Restore this version?", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), presenting: confirming) { version in
            Button("Cancel", role: .cancel) {}
            Button("Restore") { Task { await restore(version) } }
        } message: { _ in
            Text("The current version is kept, so you can undo this.")
        }
    }

    private func row(_ version: Contract.FileSnapshot) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(version.createdAt?.formatted(.dateTime.month(.abbreviated).day().hour().minute()) ?? "").text(.base).foregroundStyle(Theme.fg)
                Text(Fmt.bytes(version.sizeBytes)).text(.sm).foregroundStyle(Theme.fgMuted)
            }
            Spacer(minLength: 8)
            Button("Restore") { confirming = version }
                .buttonStyle(WebButton(variant: .secondary, size: .xs))
                .accessibilityIdentifier("file-restore-\(version.id)")
        }
        .padding(.vertical, 10)
        .accessibilityElement(children: .contain)
    }

    private func restore(_ version: Contract.FileSnapshot) async {
        failed = false
        do {
            try await world.restoreFileVersion(version.id)
            versions = (try? await world.fileVersions(path: path, agentId: agentId, on: on)) ?? versions
            restored = true
        } catch {
            restored = false
            failed = true
        }
    }
}
