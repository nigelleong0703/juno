import SwiftUI

// Settings › "Pause outgoing messages" (BACKEND 5.7.11): one switch that holds back what Juno sends to other apps and to the phone.
// Below it, one line for each app that is failing right now.

/// The pause switch as the row shows it: a change shows at once, the server's answer replaces it, a failed save puts it back.
@MainActor @Observable final class OutgoingModel {
    var list: Contract.OutboxList?
    var failed = false
    private let load: () async throws -> Contract.OutboxList
    private let freeze: (Bool) async throws -> Void

    init(load: @escaping () async throws -> Contract.OutboxList, freeze: @escaping (Bool) async throws -> Void) {
        self.load = load; self.freeze = freeze
    }

    /// Paused by the service itself: the owner's switch cannot undo it.
    var pausedByService: Bool { list?.frozen?.operator == true }
    var paused: Bool { pausedByService || list?.frozen?.owner == true }

    func refresh() async {
        do { list = try await load(); failed = false } catch where !error.isCancellation { failed = true } catch {}
    }

    func setPaused(_ paused: Bool) async {
        let before = list
        var next = list ?? Contract.OutboxList()
        var frozen = next.frozen ?? Contract.OutboxList.Frozen()
        frozen.owner = paused
        next.frozen = frozen
        list = next
        do { try await freeze(paused); await refresh() } catch { list = before; failed = true }
    }
}

enum OutgoingWords {
    static let subtitle = "Replies to Telegram, Slack and other apps, and phone notifications, wait until you turn this off."
    static let service = "Paused by the service."
    private static let shown = 3

    /// One line for each app that is failing (an app twice is one line), the first three, then "and N more".
    static func failing(_ channels: [Contract.FailingChannel]) -> [String] {
        var names: [String] = []
        for channel in channels {
            let name = ChannelPlatform(kind: channel.platform)?.name ?? (channel.platform ?? "An app").capitalized
            if !names.contains(name) { names.append(name) }
        }
        let lines = names.prefix(shown).map { "\($0) isn't delivering right now" }
        return names.count > shown ? lines + ["and \(names.count - shown) more"] : lines
    }
}

/// The settings section: the switch row, and under it the apps that are not delivering.
struct OutgoingSection: View {
    @Environment(World.self) private var world
    @State private var model: OutgoingModel?

    var body: some View {
        let failing = OutgoingWords.failing(model?.list?.health?.failing ?? [])
        Section {
            Toggle(isOn: Binding(get: { model?.paused ?? false }, set: { on in Task { await model?.setPaused(on) } })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Pause outgoing messages").foregroundStyle(Theme.fg)
                    Text(model?.pausedByService == true ? OutgoingWords.service : OutgoingWords.subtitle)
                        .text(.sm).foregroundStyle(Theme.fgMuted).fixedSize(horizontal: false, vertical: true)
                }
            }
            .tint(Theme.success)
            .disabled(model?.list == nil || model?.pausedByService == true)
            .accessibilityIdentifier("pause-outgoing")
        } footer: {
            if model?.failed == true {
                Text(model?.list == nil ? "Couldn't load this setting." : "Couldn't change this setting. Nothing changed.")
                    .foregroundStyle(Theme.danger)
            } else if !failing.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(failing, id: \.self) { Text($0).foregroundStyle(Theme.warning) }
                }
                .accessibilityIdentifier("outgoing-failing")
            }
        }
        .task {
            if model == nil { model = world.outgoingModel() }
            await model?.refresh()
        }
    }
}
