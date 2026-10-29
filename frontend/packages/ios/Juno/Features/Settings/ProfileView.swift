import SwiftUI

/// Settings → Your details: one flat list of key → value details the agents fill into forms (their own learning, plus what
/// you add). Not secret. Every edit saves the whole list (`PUT /v1/profile`). Each entry is "Only me" or "Shared" with the
/// agents' other-people contexts. Below, the details secure input kept on this iPhone (Keychain, only their names are sent).
struct ProfileView: View {
    @Environment(World.self) private var world
    @State private var entries: [Contract.ProfileEntry]?
    @State private var loadError: String?
    @State private var target: Target?
    @State private var expanded = false
    @State private var cards: [VaultEntry] = SecureVault.entries()
    @State private var error: String?
    @State private var timeZone: World.TimeZoneSetting?
    @State private var pickingZone = false
    private static let cap = 8

    enum Target: Identifiable {
        case new
        case edit(String)
        var id: String { switch self { case .new: "new"; case .edit(let id): id } }
    }

    // MARK: Body

    var body: some View {
        List {
            Group {
                if let error { Section { Text(error).foregroundStyle(Theme.danger) } }
                if let timeZone { timeZoneSection(timeZone) }
                if let entries {
                    detailsSection(entries)
                    if !cards.isEmpty { cardsSection }
                } else if let loadError {
                    Section {
                        Text(loadError).foregroundStyle(Theme.danger)
                        Button("Try again") { Task { await load() } }
                    }
                } else {
                    HStack { Spacer(); ProgressView(); Spacer() }
                }
            }
            .listRowBackground(Theme.muted)
        }
        .webGrouped()
        .pageHeader("Your details")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Add", systemImage: "plus") { target = .new }
                    .disabled(entries == nil)
                    .accessibilityIdentifier("profile-add")
            }
        }
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $target) { sheet(for: $0) }
        .sheet(isPresented: $pickingZone) {
            TimeZoneList(selection: timeZone?.zone ?? TimeZone.current.identifier) { setTimeZone(.init(zone: $0, automatic: false)) }
                .junoSheetPresentation(long: true)
        }
    }

    // MARK: Time zone

    /// "Set time zone automatically", or a zone chosen by hand (written with `timezoneAuto: false`).
    private func timeZoneSection(_ current: World.TimeZoneSetting) -> some View {
        let device = TimeZone.current.identifier
        return Section {
            Toggle("Set automatically", isOn: Binding(
                get: { current.automatic },
                set: { setTimeZone(.init(zone: $0 ? device : current.zone, automatic: $0)) }
            ))
            .tint(Theme.success)
            .accessibilityIdentifier("timezone-auto")
            if !current.automatic {
                Button { pickingZone = true } label: {
                    HStack {
                        Text("Time zone").foregroundStyle(Theme.fg)
                        Spacer()
                        Text(current.zone).foregroundStyle(Theme.fgMuted)
                        Image(systemName: "chevron.right").imageScale(.small).foregroundStyle(Theme.fgSubtle)
                    }
                    .contentShape(.rect)
                }
                .accessibilityIdentifier("timezone-pick")
            }
        } header: { Text("Time zone") } footer: {
            Text(current.automatic ? "Following this iPhone (\(device)). Your agents use it for the current time and the routines they schedule."
                                   : "Your agents use this zone for the current time and the routines they schedule, whatever this iPhone says.")
        }
    }

    private func setTimeZone(_ next: World.TimeZoneSetting) {
        let previous = timeZone
        timeZone = next
        Task {
            do { try await world.saveTimeZone(next); error = nil }
            catch { timeZone = previous; self.error = error.localizedDescription }
        }
    }

    private func detailsSection(_ all: [Contract.ProfileEntry]) -> some View {
        let shown = expanded ? all : Array(all.prefix(Self.cap))
        return Section {
            if all.isEmpty {
                Text("Nothing yet. Juno adds details here as it learns them, or add one yourself.").foregroundStyle(Theme.fgMuted)
                    .accessibilityIdentifier("profile-empty")
            }
            ForEach(shown) { entry in row(entry, all) }
            if all.count > Self.cap {
                Button(expanded ? "Show fewer" : "Show \(all.count - Self.cap) more") { withAnimation { expanded.toggle() } }
            }
        } footer: {
            Text("Your agents fill these into forms for you, so you do not retype them. They add what they learn here, and you can edit or remove anything. Passwords and card details never go here.")
        }
    }

    private func row(_ entry: Contract.ProfileEntry, _ all: [Contract.ProfileEntry]) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Button { target = .edit(entry.id) } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.key ?? "").foregroundStyle(Theme.fg).lineLimit(1)
                    Text(entry.value ?? "").text(.sm).foregroundStyle(Theme.fgMuted).lineLimit(3)
                    Text(sourceLine(entry)).text(.xs).foregroundStyle(Theme.fgSubtle).lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            Menu {
                Picker("Who can use this", selection: Binding(get: { entry.visibility == "shared" }, set: { setShared(entry.id, $0, in: all) })) {
                    Text("Only me").tag(false)
                    Text("Shared").tag(true)
                }
            } label: {
                HStack(spacing: 3) {
                    Text(entry.visibility == "shared" ? "Shared" : "Only me")
                    Image(systemName: "chevron.up.chevron.down").imageScale(.small)
                }
                .text(.sm).foregroundStyle(Theme.fgMuted)
            }
            .accessibilityIdentifier("profile-visibility-\(entry.id)")
        }
        .swipeActions { Button("Delete", role: .destructive) { Task { await commit(all.filter { $0.id != entry.id }) } } }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("profile-row-\(entry.id)")
    }

    private func sourceLine(_ entry: Contract.ProfileEntry) -> String {
        guard entry.source?.by == "agent" else { return "Added by you" }
        let name = world.agent(entry.source?.agentId)?.name ?? "your agent"
        guard let at = entry.source?.at else { return "Learned by \(name)" }
        return "Learned by \(name) · \(at.formatted(.dateTime.month(.abbreviated).day()))"
    }

    private var cardsSection: some View {
        Section {
            ForEach(cards) { entry in
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.label).foregroundStyle(Theme.fg)
                    Text(entry.kindWord).text(.sm).foregroundStyle(Theme.fgMuted)
                }
                .swipeActions { Button("Delete", role: .destructive) { removeEntry(entry) } }
                .accessibilityIdentifier("saved-\(entry.id)")
            }
        } header: { Text("Saved on this iPhone") } footer: {
            Text("Secure input can fill these in after Face ID. The values stay on this iPhone; your computer only learns the names. Security codes and one-time codes are never saved.")
        }
    }

    // MARK: Editing

    @ViewBuilder private func sheet(for target: Target) -> some View {
        let all = entries ?? []
        switch target {
        case .new:
            ProfileEntrySheet(title: "Add detail", onSave: { draft in
                let entry = Contract.ProfileEntry(id: UUID().uuidString, key: draft.trimmedKey, value: draft.trimmedValue, visibility: draft.shared ? "shared" : "private")
                try await save(all + [entry])
            }, draft: ProfileDraft())
            .junoSheetPresentation(long: true)
        case .edit(let id):
            if let current = all.first(where: { $0.id == id }) {
                ProfileEntrySheet(title: "Edit detail", onSave: { draft in
                    try await save(all.map { row in
                        guard row.id == id else { return row }
                        var next = row
                        next.key = draft.trimmedKey; next.value = draft.trimmedValue; next.visibility = draft.shared ? "shared" : "private"
                        return next
                    })
                }, draft: ProfileDraft(key: current.key ?? "", value: current.value ?? "", shared: current.visibility == "shared"))
                .junoSheetPresentation(long: true)
            }
        }
    }

    private func setShared(_ id: String, _ shared: Bool, in all: [Contract.ProfileEntry]) {
        Task {
            await commit(all.map { row in
                guard row.id == id else { return row }
                var next = row
                next.visibility = shared ? "shared" : "private"
                return next
            })
        }
    }

    // MARK: Server

    private func load() async {
        if let setting = try? await world.loadTimeZone() { timeZone = setting }
        do { entries = try await world.loadProfile(); loadError = nil }
        catch { if entries == nil { loadError = error.localizedDescription } }
    }

    private func save(_ next: [Contract.ProfileEntry]) async throws {
        entries = try await world.saveProfile(next)
        error = nil
    }

    private func commit(_ next: [Contract.ProfileEntry]) async {
        do { try await save(next) } catch { self.error = error.localizedDescription }
    }

    // MARK: Saved on this iPhone

    private func removeEntry(_ entry: VaultEntry) {
        SecureVault.delete(entry.id)
        cards = SecureVault.entries()
        world.syncVaultKeys()
    }
}

/// A searchable list of every IANA zone iOS knows; choosing one dismisses the sheet.
private struct TimeZoneList: View {
    @Environment(\.dismiss) private var dismiss
    var selection: String
    var onSelect: (String) -> Void
    @State private var query = ""

    private static let identifiers = TimeZone.knownTimeZoneIdentifiers.sorted()

    var body: some View {
        let shown = query.isEmpty ? Self.identifiers : Self.identifiers.filter { $0.localizedCaseInsensitiveContains(query) }
        NavigationStack {
            List(shown, id: \.self) { identifier in
                Button { onSelect(identifier); dismiss() } label: {
                    HStack {
                        Text(identifier).text(.lg).foregroundStyle(Theme.fg)
                        Spacer()
                        if identifier == selection { Image(systemName: "checkmark").foregroundStyle(Theme.fg) }
                    }
                }
                .listRowBackground(Theme.muted)
            }
            .webGrouped()
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always))
            .pageHeader("Time zone")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .tint(Theme.fg)
    }
}
