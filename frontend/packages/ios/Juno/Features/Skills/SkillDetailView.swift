import SwiftUI

/// One skill's detail, pushed from the Skills page: the active version, the review notice when a tool the skill
/// uses changed, an edit that saves a new version, the version history (newest first, five rows then "Show all") and rollback.
/// Same shape as the web's skill sheet; refusals show the server's reason (422) or the rollback-with-nothing-earlier line (409).
struct SkillDetailView: View {
    @Environment(World.self) private var world
    var skillId: String
    @State private var versions: [SkillVersion] = []
    @State private var loadingVersions = false
    @State private var showAllHistory = false
    @State private var name = ""
    @State private var description = ""
    @State private var instructions = ""
    @State private var seeded = false
    @State private var busy = false
    @State private var note: String?
    @State private var confirmRollback = false

    private static let historyLimit = 5
    private static let reviewNotice = "A tool this skill uses changed. Review and turn it back on."

    var body: some View {
        let skill = world.skills.first { $0.id == skillId }
        Form {
            if let note {
                Section { Text(note).foregroundStyle(Theme.danger) }
                    .listRowBackground(Theme.muted)
            }
            if let skill {
                content(skill)
            } else {
                Section { Text("This skill is no longer available.").foregroundStyle(.secondary) }
                    .listRowBackground(Theme.muted)
            }
        }
        .navigationTitle(skill?.name ?? "Skill")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { seed(skill) }
        .task { await loadVersions() }
        .confirmationDialog("Roll back this skill?", isPresented: $confirmRollback, titleVisibility: .visible) {
            Button("Roll back") { Task { await rollback() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Agents will load the previous version. The newer version stays in the history.")
        }
    }

    @ViewBuilder private func content(_ skill: Skill) -> some View {
        if skill.needsReview {
            Section {
                Text(Self.reviewNotice).foregroundStyle(Theme.warning)
                Button("Turn on") { Task { await turnOn(skill) } }
                    .disabled(busy)
            }
            .listRowBackground(Theme.muted)
        }

        Section {
            TextField("Name", text: $name)
            TextField("Description", text: $description)
            TextField("Instructions", text: $instructions, axis: .vertical)
                .lineLimit(4...12)
            Button("Save as new version") { Task { await save(skill) } }
                .disabled(busy || clean(name).isEmpty || clean(instructions).isEmpty)
        } header: {
            Text("Edit")
        } footer: {
            if let version = skill.active?.version { Text("Version \(version)") }
        }
        .listRowBackground(Theme.muted)

        Section("History") {
            if versions.isEmpty {
                Text(loadingVersions ? "Loading…" : "No earlier versions.").foregroundStyle(.secondary)
            }
            ForEach(shownVersions) { version in
                HStack {
                    Text("v\(version.version ?? 0)").fontWeight(.semibold)
                    Text(Self.statusLabel(version.status)).foregroundStyle(.secondary)
                    Spacer()
                    Text(Fmt.ago(version.createdAt)).foregroundStyle(.secondary)
                }
                .font(.subheadline)
            }
            if !showAllHistory && versions.count > Self.historyLimit {
                Button("Show all") { showAllHistory = true }
            }
            Button("Roll back") { confirmRollback = true }
                .disabled(busy || skill.active == nil)
        }
        .listRowBackground(Theme.muted)
    }

    private var shownVersions: [SkillVersion] {
        showAllHistory ? versions : Array(versions.prefix(Self.historyLimit))
    }

    private static func statusLabel(_ status: String?) -> String {
        switch status {
        case "active": return "Active"
        case "review": return "Needs review"
        case "candidate": return "Candidate"
        case "retired": return "Earlier"
        default: return status?.capitalized ?? ""
        }
    }

    private func clean(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The message for a refused request: the server's reason for a 422 (the text grants authority or holds personal data),
    /// a plain line when there is no earlier version (409), otherwise the fallback.
    private func failure(_ error: Error, fallback: String) -> String {
        guard let apiError = error as? APIError, case .api(_, let code, let message) = apiError else { return fallback }
        switch code {
        case "SKILL_INVALID": return message.isEmpty ? fallback : message
        case "SKILL_NO_PREVIOUS_VERSION": return "There is no earlier version to roll back to."
        default: return fallback
        }
    }

    private func seed(_ skill: Skill?) {
        guard !seeded, let skill else { return }
        seeded = true
        name = skill.name ?? ""
        description = skill.description ?? ""
        instructions = skill.active?.instructions ?? ""
    }

    private func loadVersions() async {
        loadingVersions = true
        defer { loadingVersions = false }
        do {
            versions = try await world.skillVersions(skillId)
        } catch {
            note = failure(error, fallback: "Could not load the history.")
        }
    }

    private func save(_ skill: Skill) async {
        busy = true
        note = nil
        defer { busy = false }
        do {
            _ = try await world.updateSkill(skill, name: clean(name), description: clean(description), instructions: clean(instructions))
            await loadVersions()
        } catch {
            note = failure(error, fallback: "Could not save the skill.")
        }
    }

    private func turnOn(_ skill: Skill) async {
        guard let version = skill.active?.version else { return }
        busy = true
        note = nil
        defer { busy = false }
        do {
            _ = try await world.activateSkillVersion(skill.id, version: version)
            await loadVersions()
        } catch {
            note = failure(error, fallback: "Could not turn the skill on.")
        }
    }

    private func rollback() async {
        busy = true
        note = nil
        defer { busy = false }
        do {
            _ = try await world.rollbackSkill(skillId)
            await loadVersions()
        } catch {
            note = failure(error, fallback: "Could not roll back the skill.")
        }
    }
}
