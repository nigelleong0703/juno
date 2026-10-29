import SwiftUI

/// People (Team, owner-approved 2026-10-26 "No boxes"; the language of Memory since 2026-10-27): the people the agents know.
/// The list is one entry per person, separated by whitespace only: the initials avatar (`PersonAvatar`, 44pt), the name large,
/// and one muted line of their relations and the platforms they chat from as small brand icons; twenty at a time. While
/// accounts may belong to someone, "N possible matches ›" with an orange dot opens them (`PeopleMatchesPage`). A tap on an
/// entry opens the person's page (`PersonDetailPage`). Each change shows at once and is put back if the server refuses it
/// (`TeamPeopleStore`), and a successful change reloads from the server.
struct TeamPeople: View {
    @Environment(World.self) private var world
    @State private var limit = 20

    var body: some View {
        let store = world.teamPeople
        if store.refused {
            Text("That change was not saved, so it is back as it was.").text(.sm).foregroundStyle(Theme.warning).teamRow(separator: false)
        }
        if !store.matches.isEmpty {
            RouteLink(route: .peopleMatches) {
                HStack(spacing: 8) {
                    Circle().fill(Theme.warning).frame(width: 7, height: 7)
                    Text(store.matches.count == 1 ? "1 possible match" : "\(store.matches.count) possible matches").text(.md).foregroundStyle(Theme.fg)
                    Image(systemName: "chevron.right").text(.xxs, .bold).foregroundStyle(Theme.fgSubtle)
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 4)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("people-matches")
            .teamRow(separator: false, vertical: 2)
        }
        TeamListView(load: store.load, emptyTitle: "No people yet", offlineText: "This is unavailable right now.") { items in
            ForEach(items.prefix(limit), id: \.id) { person in
                RouteLink(route: .person(person.id)) { PersonEntry(person: person) }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("person-row-\(person.id)")
                    .teamRow(separator: false, vertical: 9)
            }
            if items.count > limit {
                ShowMoreButton(title: "Show \(items.count - limit) more") { limit += 20 }.teamRow(separator: false)
            }
        }
    }
}

/// One person in the list: the avatar, the name (with a "You" tag on the owner's own person), then a muted line: relations
/// first ("Juno's friend"), then the platforms as small brand icons.
private struct PersonEntry: View {
    @Environment(World.self) private var world
    var person: Contract.PersonView

    var body: some View {
        let name = PeopleLabel.name(person, world: world)
        let relations = (person.relations ?? []).prefix(2).map { PeopleLabel.relationPhrase($0) }.joined(separator: ", ")
        HStack(spacing: 14) {
            PersonAvatar(name: name, size: 44)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(name).text(.xl, .semibold).foregroundStyle(Theme.fg).lineLimit(1)
                    if person.isOwner == true { Text("You").text(.sm).foregroundStyle(Theme.fgSubtle) }
                }
                HStack(spacing: 8) {
                    if !relations.isEmpty {
                        Text(PeopleLabel.capitalised(relations)).text(.md).foregroundStyle(Theme.fgMuted).lineLimit(1)
                    }
                    HStack(spacing: 4) {
                        ForEach(platforms, id: \.self) { platform in
                            BrandIcon(catalogId: platform, symbol: "person.crop.circle", size: 20).accessibilityLabel(PeopleLabel.platformName(platform))
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
    }

    /// The distinct platforms of the person's accounts, in the order they were linked.
    private var platforms: [String] {
        var seen: [String] = []
        for platform in (person.accounts ?? []).compactMap(\.platform) where !seen.contains(platform) { seen.append(platform) }
        return seen
    }
}

/// The words the People screens use, in one place.
enum PeopleLabel {
    static func platformName(_ platform: String?) -> String {
        guard let platform, !platform.isEmpty else { return "" }
        return ChannelPlatform(kind: platform)?.name ?? platform.prefix(1).uppercased() + platform.dropFirst()
    }

    /// "Discord · AlexH".
    static func account(_ account: Contract.AccountView?) -> String {
        [platformName(account?.platform), account?.name].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " \u{00B7} ")
    }

    /// "Discord · AlexH might be AlexH".
    static func match(_ match: Contract.PossibleMatch) -> String {
        "\(account(match.account)) might be \(match.person?.name ?? "")"
    }

    /// "@AlexH" for a handle, the display name as it is when it has spaces ("Mina T"), nil when the platform showed none.
    static func handle(_ account: Contract.AccountView) -> String? {
        guard let name = account.name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { return nil }
        if name.contains(where: \.isWhitespace) { return name }
        return name.hasPrefix("@") ? name : "@\(name)"
    }

    /// "@AlexH on Discord", or "a Discord account" when no name was seen (web `accountPhrase`).
    static func accountPhrase(_ account: Contract.AccountView) -> String {
        let platform = platformName(account.platform)
        return handle(account).map { "\($0) on \(platform)" } ?? "a \(platform) account"
    }

    /// A relation as the phrase of the person's sentence, from their side: "Ola's friend", "Ola's manager", "works at Acme"
    /// (web `relationPhrase`; `out` means this person is the first end of the relation).
    /// `you` is for the owner's own person, whose sentence is "You are …": the one verb phrase reads "employed by Acme" there.
    static func relationPhrase(_ relation: Contract.PersonRelationView, you: Bool = false) -> String {
        let other = relation.otherName ?? ""
        let out = relation.direction != "in"
        switch relation.kind ?? "" {
        case "manager_of": return out ? "\(other)'s manager" : "\(other)'s report"
        case "client_of": return out ? "\(other)'s client" : "\(other)'s provider"
        case "works_at": return out ? (you ? "employed by \(other)" : "works at \(other)") : "\(other)'s employer"
        case "parent_of": return out ? "\(other)'s parent" : "\(other)'s child"
        case "colleague", "spouse", "sibling", "friend": return "\(other)'s \(relation.kind ?? "")"
        default:
            // `other`, or a kind this client has no wording for: the server's own word.
            return "\(other)'s \(relation.kindLabel ?? (relation.kind ?? "").replacingOccurrences(of: "_", with: " "))"
        }
    }

    /// A relation of the owner's own person: "You are Juno's friend", "You are employed by Acme".
    static func youAre(_ relation: Contract.PersonRelationView) -> String { "You are \(relationPhrase(relation, you: true))" }

    /// The first letter upper-cased ("works at Acme" starts a sentence).
    static func capitalised(_ text: String) -> String { text.prefix(1).uppercased() + text.dropFirst() }

    /// The owner's own person shows the signed-in user's name (the one in the Today greeting), not the stored "Owner".
    @MainActor static func name(_ person: Contract.PersonView, world: World) -> String {
        if person.isOwner == true, let name = world.session?.name, !name.isEmpty { return name }
        return person.name ?? ""
    }
}

// MARK: - Possible matches

/// The accounts the backend suggests belong to someone: one line each ("Discord · AlexH might be AlexH") with Link, which
/// asks first. A linked match leaves the list at once and comes back if the server refuses it.
struct PeopleMatchesPage: View {
    @Environment(World.self) private var world
    @State private var linking: Contract.PossibleMatch?

    var body: some View {
        let store = world.teamPeople
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if store.matches.isEmpty {
                    Text("No possible matches.").text(.sm).foregroundStyle(Theme.fgMuted)
                }
                if store.refused {
                    Text("That change was not saved, so it is back as it was.").text(.sm).foregroundStyle(Theme.warning)
                }
                ForEach(store.matches.indices, id: \.self) { index in
                    let match = store.matches[index]
                    HStack(spacing: 12) {
                        if let platform = match.account?.platform { BrandIcon(catalogId: platform, symbol: "person.crop.circle", size: 28) }
                        Text(PeopleLabel.match(match)).text(.lg).foregroundStyle(Theme.fg).fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                        Button("Link") { linking = match }
                            .buttonStyle(WebButton(variant: .secondary, size: .sm))
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Theme.canvas)
        .pageHeader("Possible matches")
        .alert("Link this account?", isPresented: Binding(get: { linking != nil }, set: { if !$0 { linking = nil } }), presenting: linking) { match in
            Button("Link") { store.link(world, match) }
            Button("Cancel", role: .cancel) {}
        } message: { match in
            Text("\(PeopleLabel.account(match.account)) will be linked to \(match.person?.name ?? ""). You can unlink it again later.")
        }
    }
}

// MARK: - Detail

/// A phrase's link in a person's prose: `juno-person://<account|relation|more>?id=<id>`, read back by the prose's `openURL`.
private enum PersonLink {
    static func url(_ kind: String, _ id: String) -> URL? {
        var parts = URLComponents()
        parts.scheme = "juno-person"
        parts.host = kind
        parts.queryItems = [URLQueryItem(name: "id", value: id)]
        return parts.url
    }

    static func parse(_ url: URL) -> (kind: String, id: String)? {
        guard url.scheme == "juno-person", let kind = url.host,
              let id = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "id" })?.value else { return nil }
        return (kind, id)
    }
}

/// The sheet a phrase (or the top bar's menu) opens.
private enum PersonSheet: Identifiable, Hashable {
    case account(String), relation(String), rename
    var id: String {
        switch self {
        case .account(let id): "account-\(id)"
        case .relation(let id): "relation-\(id)"
        case .rename: "rename"
        }
    }
}

/// One person: the large initials avatar and name, then prose in Memory's paragraph type. "Reaches your team as @AlexH on
/// Discord and @big on Telegram." (each account a dotted-underlined phrase that opens its sheet: Unlink, after a confirm) and
/// "Juno's friend and Sol's colleague." (each relation a phrase that opens its sheet: Confirm, Remove). With neither, one
/// muted line. Rename is in the top bar's "…" menu.
struct PersonDetailPage: View {
    @Environment(World.self) private var world
    var personId: String
    @State private var sheet: PersonSheet?
    @State private var expanded: Set<String> = []

    /// Phrases of one sentence before "and N more".
    private static let phraseLimit = 5

    var body: some View {
        let store = world.teamPeople
        ScrollView {
            if let person = store.person(personId) {
                let name = PeopleLabel.name(person, world: world)
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 12) {
                        PersonAvatar(name: name, size: 88)
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(name).text(.xxl, .bold).foregroundStyle(Theme.fg).lineLimit(2)
                            if person.isOwner == true { Text("You").text(.lg).foregroundStyle(Theme.fgSubtle) }
                        }
                        .accessibilityAddTraits(.isHeader)
                    }
                    if store.refused {
                        Text("That change was not saved, so it is back as it was.").text(.sm).foregroundStyle(Theme.warning)
                    }
                    let accounts = person.accounts ?? []
                    let relations = person.relations ?? []
                    if !accounts.isEmpty {
                        prose(person.isOwner == true ? "You reach your team as " : "Reaches your team as ", kind: "account", capitalise: false,
                              accounts.map { Phrase(id: $0.id, text: PeopleLabel.accountPhrase($0), unconfirmed: false) })
                    }
                    if !relations.isEmpty {
                        let you = person.isOwner == true
                        prose(you ? "You are " : "", kind: "relation", capitalise: !you,
                              relations.map { Phrase(id: $0.id, text: PeopleLabel.relationPhrase($0, you: you), unconfirmed: $0.confirmed != true) })
                    }
                    if accounts.isEmpty && relations.isEmpty {
                        Text("Nothing known about them yet.").text(.md).foregroundStyle(Theme.fgMuted)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .environment(\.openURL, OpenURLAction { url in
                    guard let link = PersonLink.parse(url) else { return .discarded }
                    switch link.kind {
                    case "account": sheet = .account(link.id)
                    case "relation": sheet = .relation(link.id)
                    case "more": expanded.insert(link.id)
                    default: return .discarded
                    }
                    return .handled
                })
            } else {
                Text("This person is no longer there.").text(.sm).foregroundStyle(Theme.fgMuted).padding(16)
            }
        }
        .background(Theme.canvas)
        .pageHeader("Person")
        .toolbar {
            if store.person(personId) != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Rename", systemImage: "pencil") { sheet = .rename }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .accessibilityLabel("More")
                    .accessibilityIdentifier("person-menu")
                }
            }
        }
        .sheet(item: $sheet) { sheet in
            switch sheet {
            case .account(let id): PersonAccountSheet(personId: personId, accountId: id)
            case .relation(let id): PersonRelationSheet(personId: personId, relationId: id)
            case .rename: RenamePersonSheet(personId: personId)
            }
        }
    }

    private struct Phrase {
        var id: String
        var text: String
        var unconfirmed: Bool
    }

    /// A paragraph: `lead`, the phrases as dotted-underlined links joined "a, b and c" (an unconfirmed one in italic), then a
    /// full stop. Past `phraseLimit` the rest folds into "and N more", which expands them.
    private func prose(_ lead: String, kind: String, capitalise: Bool, _ phrases: [Phrase]) -> some View {
        let open = expanded.contains(kind)
        let shown = open ? phrases : Array(phrases.prefix(Self.phraseLimit))
        let hidden = phrases.count - shown.count
        var out = AttributedString(lead)
        for (index, phrase) in shown.enumerated() {
            var run = AttributedString(capitalise && index == 0 ? PeopleLabel.capitalised(phrase.text) : phrase.text)
            run.link = PersonLink.url(kind, phrase.id)
            run.underlineStyle = Text.LineStyle(pattern: .dot, color: Theme.fg.opacity(0.35))
            if phrase.unconfirmed { run.inlinePresentationIntent = .emphasized }
            out += run
            if index < shown.count - 1 { out += AttributedString(index == shown.count - 2 && hidden == 0 ? " and " : ", ") }
        }
        if hidden > 0 {
            var more = AttributedString("and \(hidden) more")
            more.link = PersonLink.url("more", kind)
            out += AttributedString(" ") + more
        }
        out += AttributedString(".")
        return Text(out)
            .text(.xl).foregroundStyle(Theme.fg).tint(Theme.fg)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One account in the app's sheet format: its platform icon and handle, where it was last seen, and Unlink (after a confirm).
/// Closes by itself once the account is gone.
private struct PersonAccountSheet: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var personId: String
    var accountId: String
    @State private var confirmUnlink = false

    var body: some View {
        let store = world.teamPeople
        let person = store.person(personId)
        let account = person?.accounts?.first { $0.id == accountId }
        JunoSheet(icon: "person.crop.circle", title: PeopleLabel.platformName(account?.platform), cancel: "Close", fitsContent: true, id: "person-account",
                  onCancel: { dismiss() }) {
            if let account {
                HStack(spacing: 14) {
                    BrandIcon(catalogId: account.platform, symbol: "person.crop.circle", size: 44)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(PeopleLabel.handle(account) ?? PeopleLabel.platformName(account.platform))
                            .text(.lg, .medium).foregroundStyle(Theme.fg).lineLimit(1)
                        Text(seen(account)).text(.md).foregroundStyle(Theme.fgMuted)
                    }
                }
                Button { confirmUnlink = true } label: { Text("Unlink").foregroundStyle(Theme.danger).frame(maxWidth: .infinity) }
                    .buttonStyle(WebButton(variant: .secondary, size: .large))
                    .accessibilityIdentifier("person-account-unlink")
            }
        }
        .onChange(of: account == nil) { _, gone in if gone { dismiss() } }
        .confirmationDialog("Unlink this account?", isPresented: $confirmUnlink, titleVisibility: .visible) {
            Button("Unlink", role: .destructive) {
                if let account, let person { store.unlink(world, account, of: person) }
                dismiss()
            }
        } message: {
            Text("\(PeopleLabel.account(account)) will no longer count as \(person.map { PeopleLabel.name($0, world: world) } ?? "this person").")
        }
    }

    /// "Last seen in Family · 20 Oct 2026".
    private func seen(_ account: Contract.AccountView) -> String {
        let when = account.lastSeen?.formatted(date: .abbreviated, time: .omitted)
        switch (account.lastChat, when) {
        case (let chat?, let when?): return "Last seen in \(chat) \u{00B7} \(when)"
        case (let chat?, nil): return "Last seen in \(chat)"
        case (nil, let when?): return "Last seen \(when)"
        default: return ""
        }
    }
}

/// One relation in the app's sheet format: how it reads, whether the owner has confirmed it, Confirm (when not) and Remove.
/// Closes by itself once the relation is gone.
private struct PersonRelationSheet: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var personId: String
    var relationId: String

    var body: some View {
        let store = world.teamPeople
        let person = store.person(personId)
        let relation = person?.relations?.first { $0.id == relationId }
        JunoSheet(icon: "person.2",
                  title: relation.map { person?.isOwner == true ? PeopleLabel.youAre($0) : PeopleLabel.capitalised(PeopleLabel.relationPhrase($0)) } ?? "Relation",
                  guidance: relation.map { $0.confirmed == true ? "You said this or confirmed it." : "Picked up from a chat. Confirm it if it is right." },
                  cancel: "Close", fitsContent: true, id: "person-relation",
                  onCancel: { dismiss() }) {
            if let relation, let person {
                if relation.confirmed != true {
                    Button("Confirm") {
                        store.confirm(world, relation, of: person)
                        dismiss()
                    }
                    .buttonStyle(WebButton(variant: .primary, size: .large))
                    .frame(maxWidth: .infinity)
                    .accessibilityIdentifier("person-relation-confirm")
                }
                Button {
                    store.remove(world, relation, of: person)
                    dismiss()
                } label: { Text("Remove").foregroundStyle(Theme.danger).frame(maxWidth: .infinity) }
                    .buttonStyle(WebButton(variant: .secondary, size: .large))
                    .accessibilityIdentifier("person-relation-remove")
            }
        }
        .onChange(of: relation == nil) { _, gone in if gone { dismiss() } }
    }
}

/// The rename sheet (`JunoSheet`): the name as a field, Save disabled while it is empty or unchanged.
private struct RenamePersonSheet: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var personId: String
    @State private var name = ""

    var body: some View {
        let store = world.teamPeople
        let person = store.person(personId)
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        JunoSheet(icon: "pencil", title: "Rename", guidance: "The name the agents use for them.", primary: "Save",
                  primaryEnabled: !trimmed.isEmpty && trimmed != person?.name, cancel: "Cancel", id: "person-rename",
                  onPrimary: {
                      if let person { store.rename(world, person, to: trimmed) }
                      dismiss()
                  },
                  onCancel: { dismiss() }) {
            JunoFormField(label: "Name") {
                TextField("", text: $name)
                    .inputField()
                    .accessibilityIdentifier("person-rename-name")
            }
        }
        .onAppear { name = person?.name ?? "" }
    }
}
