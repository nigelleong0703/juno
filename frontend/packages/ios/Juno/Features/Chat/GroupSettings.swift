import SwiftUI

// A platform group's settings (contracts 0.73 `GroupSettings`, BACKEND 6.8), opened from the group's header menu: whether the
// agent reads the channel, what it read from before it joined, "May speak up without being @mentioned", and the kinds of
// decision a teammate's ask may use without asking the owner. Each change saves at once and goes back if the save fails.
// Same words and order as the web panel (`GroupChannelSettings.tsx`).

/// The words of the sheet and of the approval card's "who asked" line.
enum GroupWords {
    static let delegable = ["spending", "speaking", "public", "committing", "sharing"]

    static func platformName(_ kind: String?) -> String {
        ChannelPlatform(kind: kind)?.name ?? (kind ?? "The platform").capitalized
    }

    static func observes(_ settings: Contract.GroupSettings, agent: String) -> String {
        settings.observes == true
            ? "\(agent) reads this channel to keep context."
            : "\(agent) only gets what is addressed to it here. The platform does not pass on the rest (Telegram privacy mode, or a Feishu permission)."
    }

    /// What the agent has read of the channel's past; nil before the first read starts.
    static func backfill(_ settings: Contract.GroupSettings, agent: String) -> String? {
        guard let backfill = settings.backfill else { return nil }
        switch backfill.status {
        case "running": return "Reading earlier messages…"
        case "unavailable": return "\(platformName(settings.platform)) does not let \(agent) read earlier messages."
        case "failed": return "Could not read the earlier messages."
        default:
            let frac = ISO8601DateFormatter()
            frac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let date = backfill.at.flatMap { frac.date(from: $0) ?? ISO8601DateFormatter().date(from: $0) }
            let when = date.map { whenFormat.string(from: $0) }
            return ["Read \(backfill.count ?? 0) earlier messages", when].compactMap { $0 }.joined(separator: " · ")
        }
    }

    private static let whenFormat: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_GB")
        formatter.setLocalizedDateFormatFromTemplate("d MMM, HH:mm")
        return formatter
    }()

    /// "Mia asked in Design team", "Someone outside the team asked": who asked an approval, when someone other than the owner did in a platform chat.
    static func askedBy(_ asked: Contract.ApprovalPayload.AskedBy?) -> String? {
        guard let asked else { return nil }
        let name = asked.name?.trimmingCharacters(in: .whitespaces)
        let hasName = !(name ?? "").isEmpty
        let who = asked.kind == "stranger"
            ? (hasName ? "\(name!), someone outside the team, asked" : "Someone outside the team asked")
            : (hasName ? "\(name!) asked" : "A teammate asked")
        guard let place = asked.where?.trimmingCharacters(in: .whitespaces), !place.isEmpty else { return who }
        return "\(who) in \(place)"
    }
}

/// The settings as the sheet shows them: a change shows at once, the server's answer replaces it, a failed save puts the old ones back.
@MainActor @Observable final class GroupSettingsModel {
    struct Change: Encodable { var speak: Bool?; var delegated: [String]? }

    var settings: Contract.GroupSettings?
    var failed = false
    private let load: () async throws -> Contract.GroupSettings
    private let save: (Change) async throws -> Contract.GroupSettings

    init(load: @escaping () async throws -> Contract.GroupSettings, save: @escaping (Change) async throws -> Contract.GroupSettings) {
        self.load = load; self.save = save
    }

    func refresh() async {
        do { settings = try await load(); failed = false } catch where !error.isCancellation { failed = true } catch {}
    }

    func apply(_ change: Change) async {
        guard let before = settings else { return }
        var next = before
        if let speak = change.speak { next.speak = speak }
        if let delegated = change.delegated { next.delegated = delegated }
        settings = next
        do { settings = try await save(change) } catch { settings = before; failed = true }
    }

    func toggle(_ category: String) async {
        var kinds = settings?.delegated ?? []
        if let index = kinds.firstIndex(of: category) { kinds.remove(at: index) } else { kinds.append(category) }
        await apply(Change(delegated: kinds))
    }
}

struct GroupSettingsSheet: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var conversationId: String
    @State private var model: GroupSettingsModel?

    private var agentName: String {
        world.conversation(conversationId)?.agentIds?.first.flatMap { world.agent($0)?.name } ?? "The agent"
    }

    var body: some View {
        JunoSheet(icon: "person.2", title: "In this channel", fitsContent: true, id: "group-settings", onCancel: { dismiss() }) {
            if let model, let settings = model.settings {
                content(model, settings)
            } else if model?.failed == true {
                JunoMessage(text: "Could not load the channel settings.", id: "group-settings-error")
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .task {
            guard model == nil else { return }
            model = world.groupSettingsModel(conversationId)
            await model?.refresh()
        }
    }

    @ViewBuilder private func content(_ model: GroupSettingsModel, _ settings: Contract.GroupSettings) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(GroupWords.observes(settings, agent: agentName)).text(.base).foregroundStyle(Theme.fg)
            if let line = GroupWords.backfill(settings, agent: agentName) {
                Text(line).text(.sm).foregroundStyle(Theme.fgMuted)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        JunoFormField(label: "Speaking up", help: "\(agentName) may join a thread when something needs a follow-up or an answer only it has.") {
            Toggle("May speak up without being @mentioned", isOn: Binding(
                get: { settings.speak == true }, set: { speak in Task { await model.apply(.init(speak: speak)) } }))
                .tint(Theme.success).accessibilityIdentifier("group-speak").inputField()
        }
        JunoFormField(label: "Teammates can ask without checking with you for:", help: "Anything not ticked still asks you first.") {
            VStack(spacing: 8) {
                ForEach(GroupWords.delegable, id: \.self) { category in
                    JunoCheckRow(title: DecisionWords.badge(category), selected: settings.delegated?.contains(category) == true, id: "group-delegate-\(category)") {
                        Task { await model.toggle(category) }
                    }
                }
            }
        }
        if model.failed { JunoMessage(text: "Could not save. Nothing changed.", id: "group-settings-error") }
    }
}
