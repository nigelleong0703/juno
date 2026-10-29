import SwiftUI

/// Memory, as Muse shows it: the files the agents keep about the user, readable and editable (MEMORY.md, the
/// About-you bank, people pages), the read-only daily notes and learned reply style, and the claims behind them
/// with the words that back each one and a way to forget. Memory is about the user, so it is shared by every agent.

/// The lines of a file a search hit points at.
struct MemoryMatch: Hashable {
    var line: Int
    var text: String
}

enum MemoryDest: Hashable {
    case bank, people, daily, claims
    case file(String, MemoryMatch?)
}

/// The views a search hit is shown in (`MemorySearchHit.file`): `memory`, `bank:<name>`, or `person`.
enum MemoryView {
    /// The file a hit opens: MEMORY.md or a bank file. Nil for a person page, since the hit carries no path.
    static func destination(_ file: String?) -> MemoryDest? {
        let view = file ?? ""
        if view == "memory" { return .file("MEMORY.md", nil) }
        if view.hasPrefix("bank:") { return .file("memory/bank/\(view.dropFirst("bank:".count)).md", nil) }
        return nil
    }

    static func label(_ file: String?) -> String {
        switch file ?? "" {
        case "memory": return "Memory"
        case "bank:circumstances": return "Circumstances"
        case "bank:experiences": return "Experiences"
        case "bank:preferences": return "Preferences"
        case "person": return "People"
        default: return file ?? ""
        }
    }
}

/// The global Memory page and the agent's Memory sheet.
struct MemoryPage: View {
    @Environment(World.self) private var world
    @State private var query = ""
    @State private var hits: [Contract.MemorySearchHit] = []
    @State private var searchFailed = false
    @State private var limit = 10

    private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        List {
            if trimmed.isEmpty {
                Section {
                    memoryRow("Memory", "The short sheet every agent reads first", "brain", .file("MEMORY.md", nil))
                    memoryRow("About you", "Circumstances, experiences, preferences", "person.text.rectangle", .bank)
                    memoryRow("People", "One page per person in your life", "person.2", .people)
                    memoryRow("Daily notes", "What each agent wrote down, by day", "calendar", .daily)
                    memoryRow("Learned reply style", "How you like to be answered", "text.bubble", .file("ALIGNMENT_SYNTHESIS.md", nil))
                }
                Section {
                    memoryRow("What I know and why", "Claims with your own words as proof", "quote.bubble", .claims)
                }
            } else if searchFailed {
                Section { Text("Search failed. Try again.").foregroundStyle(Theme.danger).listRowBackground(Theme.muted) }
            } else if hits.isEmpty {
                Section { Text("Nothing in your memory matches that.").foregroundStyle(Theme.fgMuted).listRowBackground(Theme.muted) }
            } else {
                Section {
                    ForEach(hits.prefix(limit)) { hit in
                        hitRow(hit).listRowBackground(Theme.muted)
                    }
                    ShowMore(shown: limit, total: hits.count) { limit += 10 }.listRowBackground(Color.clear)
                }
            }
        }
        .webGrouped()
        .pageHeader("Memory")
        .searchable(text: $query, prompt: "Search memory")
        .navigationDestination(for: MemoryDest.self) { MemoryScreen(dest: $0) }
        .task(id: trimmed) { await search() }
    }

    /// One search hit: its text, and the view it is in. A bank hit opens its file; a person hit has no path, so it is not a link.
    @ViewBuilder private func hitRow(_ hit: Contract.MemorySearchHit) -> some View {
        let label = VStack(alignment: .leading, spacing: 2) {
            Text(hit.text ?? "").text(.base).foregroundStyle(Theme.fg).lineLimit(2)
            Text(MemoryView.label(hit.file)).text(.xs).foregroundStyle(Theme.fgSubtle)
        }
        if let dest = MemoryView.destination(hit.file) {
            NavigationLink(value: dest) { label }
        } else {
            label
        }
    }

    private func memoryRow(_ title: String, _ subtitle: String, _ symbol: String, _ dest: MemoryDest) -> some View {
        NavigationLink(value: dest) {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).text(.md, .medium).foregroundStyle(Theme.fg)
                    Text(subtitle).text(.sm).foregroundStyle(Theme.fgMuted)
                }
            } icon: { Image(systemName: symbol).foregroundStyle(Theme.fgMuted) }
        }
        .listRowBackground(Theme.muted)
    }

    @MainActor private func search() async {
        hits = []
        searchFailed = false
        limit = 10
        guard !trimmed.isEmpty else { return }
        do {
            try await Task.sleep(for: .milliseconds(300))
            hits = try await world.searchMemory(trimmed)
        } catch is CancellationError {
        } catch {
            searchFailed = true
        }
    }
}

/// The agent's Memory card opens the same page in a sheet.
struct MemorySheet: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            MemoryPage().toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

private struct MemoryScreen: View {
    var dest: MemoryDest
    var body: some View {
        switch dest {
        case .bank: BankList()
        case .people: PeopleList()
        case .daily: DailyNotes()
        case .claims: ClaimsList()
        case .file(let path, let match): MemoryFileScreen(path: path, match: match)
        }
    }
}

/// One memory file: editable where the user may write it (MEMORY.md, the bank, people pages), read-only otherwise.
private struct MemoryFileScreen: View {
    var path: String
    var match: MemoryMatch?

    var body: some View {
        if path == "MEMORY.md" {
            HomeFileEditor(path: path, title: "Memory", hint: "The short sheet every agent reads first: facts, preferences and commitments. Edit it freely.",
                           note: "About this file. This is the short sheet of what your agents remember about you. A background task keeps it up to date from your conversations. You can edit it at any time. This note is not part of the file.", match: match)
        } else if path.hasPrefix("memory/bank/") {
            HomeFileEditor(path: path, title: BankList.title(path), match: match)
        } else if path.hasPrefix("people/") {
            PersonScreen(path: path, match: match)
        } else {
            ReadOnlyFile(path: path, title: path == "ALIGNMENT_SYNTHESIS.md" ? "Learned reply style" : DailyNotes.title(path), match: match,
                         hint: path == "ALIGNMENT_SYNTHESIS.md" ? "How you like to be answered, learned from your conversations. Read-only." : "What the agent wrote down that day. Read-only.")
        }
    }
}

/// The muted italic note above a home file, set off by a left rule; the text says it is not part of the file.
struct FileNote: View {
    var text: String
    var body: some View {
        Text(text).text(.xs).italic().foregroundStyle(Theme.fgMuted)
            .padding(.leading, 12).frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .leading) { Rectangle().fill(Theme.border).frame(width: 2) }
    }
}

/// A file's text in a Form row, edited in place. Saved with the hash it was loaded with: if the file changed
/// elsewhere it is reloaded instead of overwritten. `editable`/`merge` let a screen edit only part of a file;
/// `extra` shows the rest below (it gets the whole loaded text).
struct HomeFileEditor<Extra: View>: View {
    @Environment(World.self) private var world
    var path: String
    var title: String
    var hint: String?
    var note: String?
    var match: MemoryMatch?
    var editable: (String) -> String
    var merge: (String, String) -> String
    var extra: (String) -> Extra
    @State private var text = ""
    @State private var loaded: Contract.AgentHomeFile?
    @State private var isLoading = true
    @State private var isSaving = false
    @State private var error: String?

    init(path: String, title: String, hint: String? = nil, note: String? = nil, match: MemoryMatch? = nil,
         editable: @escaping (String) -> String = { $0 }, merge: @escaping (String, String) -> String = { edited, _ in edited },
         @ViewBuilder extra: @escaping (String) -> Extra) {
        self.path = path; self.title = title; self.hint = hint; self.note = note; self.match = match
        self.editable = editable; self.merge = merge; self.extra = extra
    }

    private var served: String { editable(loaded?.content ?? "") }

    var body: some View {
        Form {
            if let note {
                Section { FileNote(text: note).listRowBackground(Color.clear) }
            }
            if let match {
                Section("Found at line \(match.line)") { Text(match.text).text(.sm).foregroundStyle(Theme.fgMuted).listRowBackground(Theme.muted) }
            }
            Section {
                TextField("Nothing here yet", text: $text, axis: .vertical)
                    .lineLimit(6...30)
                    .foregroundStyle(Theme.fg)
                    .listRowBackground(Theme.muted)
                    .accessibilityIdentifier("memory-editor")
            } footer: {
                if let hint { Text(hint) }
            }
            extra(loaded?.content ?? "")
            if let error { Section { Text(error).foregroundStyle(Theme.danger).listRowBackground(Theme.muted) } }
        }
        .webGrouped()
        .disabled(isLoading || isSaving)
        .overlay { if isLoading { ProgressView() } }
        .pageHeader(title)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { Task { await save() } }.disabled(isLoading || isSaving || text == served)
            }
        }
        .task(id: world.homeRevision) { await load(resetText: text == served) }
    }

    @MainActor private func load(resetText: Bool) async {
        defer { isLoading = false }
        do {
            loaded = try await world.homeFiles(path).first { $0.path == path }
            if resetText { text = served }
        } catch {
            self.error = error.localizedDescription
        }
    }

    @MainActor private func save() async {
        isSaving = true
        error = nil
        do {
            try await world.writeHomeFile(path, content: merge(text, loaded?.content ?? ""), expectedHash: loaded?.hash)
            await load(resetText: true)
        } catch let failure where failure.isHomeConflict {
            await load(resetText: true)
            error = "This changed elsewhere and was reloaded. Review it and make your edit again."
        } catch {
            self.error = error.localizedDescription
        }
        isSaving = false
    }
}

extension HomeFileEditor where Extra == EmptyView {
    init(path: String, title: String, hint: String? = nil, note: String? = nil, match: MemoryMatch? = nil) {
        self.init(path: path, title: title, hint: hint, note: note, match: match) { _ in EmptyView() }
    }
}

/// A file the user may read but not change.
private struct ReadOnlyFile: View {
    @Environment(World.self) private var world
    var path: String
    var title: String
    var match: MemoryMatch?
    var hint: String
    @State private var text: String?

    var body: some View {
        List {
            if let match {
                Section("Found at line \(match.line)") { Text(match.text).text(.sm).foregroundStyle(Theme.fgMuted).listRowBackground(Theme.muted) }
            }
            Section {
                if let text {
                    Text(text.isEmpty ? "Nothing here yet." : text).text(.base).foregroundStyle(text.isEmpty ? Theme.fgMuted : Theme.fg)
                        .textSelection(.enabled).listRowBackground(Theme.muted)
                } else {
                    ProgressView().frame(maxWidth: .infinity).listRowBackground(Theme.muted)
                }
            } footer: { Text(hint) }
        }
        .webGrouped()
        .pageHeader(title)
        .task(id: world.homeRevision) {
            let file = try? await world.homeFiles(path).first { $0.path == path }
            text = (file?.content ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }
}

// MARK: - About you (the bank)

private struct BankList: View {
    static let files = [("circumstances", "Circumstances"), ("experiences", "Experiences"), ("preferences", "Preferences")]
    static func title(_ path: String) -> String {
        files.first { path == "memory/bank/\($0.0).md" }?.1 ?? path
    }

    var body: some View {
        List {
            Section {
                ForEach(Self.files, id: \.0) { file, title in
                    NavigationLink(value: MemoryDest.file("memory/bank/\(file).md", nil)) { Text(title).foregroundStyle(Theme.fg) }
                        .listRowBackground(Theme.muted)
                }
            } footer: { Text("What your agents learned about you, sorted into three files. Edit any of them.") }
        }
        .webGrouped()
        .pageHeader("About you")
    }
}

// MARK: - People

/// A people page: the shared body (editable) and the per-agent `## name（id）` sections (read-only).
enum PersonPage {
    static func split(_ content: String) -> (body: String, sections: [(heading: String, text: String)]) {
        let lines = content.components(separatedBy: "\n")
        let starts = lines.indices.filter { lines[$0].hasPrefix("## ") && lines[$0].trimmingCharacters(in: .whitespaces).hasSuffix("）") && lines[$0].contains("（") }
        guard let first = starts.first else { return (content, []) }
        let body = lines[..<first].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines) + "\n"
        let sections = starts.enumerated().map { n, start -> (String, String) in
            let end = n + 1 < starts.count ? starts[n + 1] : lines.count
            let heading = String(lines[start].dropFirst(3)).trimmingCharacters(in: .whitespaces)
            return (heading, lines[(start + 1)..<end].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return (body, sections)
    }

    static func join(_ body: String, _ sections: [(heading: String, text: String)]) -> String {
        let head = body.trimmingCharacters(in: .whitespacesAndNewlines) + "\n"
        guard !sections.isEmpty else { return head }
        return head + "\n" + sections.map { "## \($0.heading)\n\n\($0.text)" }.joined(separator: "\n\n") + "\n"
    }

    static func name(_ path: String, _ content: String) -> String {
        if let heading = content.components(separatedBy: "\n").first(where: { $0.hasPrefix("# ") }) {
            return String(heading.dropFirst(2)).trimmingCharacters(in: .whitespaces)
        }
        return ((path as NSString).lastPathComponent as NSString).deletingPathExtension
    }
}

private struct PersonScreen: View {
    @Environment(World.self) private var world
    var path: String
    var match: MemoryMatch?
    @State private var title = ""

    var body: some View {
        HomeFileEditor(path: path, title: title.isEmpty ? "Person" : title, match: match,
                       editable: { PersonPage.split($0).body },
                       merge: { edited, full in PersonPage.join(edited, PersonPage.split(full).sections) }) { full in
            ForEach(PersonPage.split(full).sections, id: \.heading) { section in
                Section {
                    Text(section.text).text(.base).foregroundStyle(Theme.fg).listRowBackground(Theme.muted)
                } header: { Text(section.heading) } footer: { Text("Written by this agent from its own dealings with this person. Read-only.") }
            }
        }
        .task(id: world.homeRevision) {
            let file = try? await world.homeFiles(path).first { $0.path == path }
            title = PersonPage.name(path, file?.content ?? "")
        }
    }
}

private struct PeopleList: View {
    @Environment(World.self) private var world
    @State private var people: [(path: String, name: String)] = []
    @State private var loaded = false
    @State private var limit = 20

    var body: some View {
        List {
            Section {
                if loaded && people.isEmpty { Text("No people pages yet.").foregroundStyle(Theme.fgMuted).listRowBackground(Theme.muted) }
                ForEach(people.prefix(limit), id: \.path) { person in
                    NavigationLink(value: MemoryDest.file(person.path, nil)) { Text(person.name).foregroundStyle(Theme.fg) }
                        .listRowBackground(Theme.muted)
                }
                ShowMore(shown: limit, total: people.count) { limit += 20 }.listRowBackground(Color.clear)
            } footer: { Text("One page per person in your life. Open one to read or edit it.") }
        }
        .webGrouped()
        .overlay { if !loaded { ProgressView() } }
        .pageHeader("People")
        .task(id: world.homeRevision) {
            let files = (try? await world.homeFiles("people/")) ?? []
            people = files.compactMap { f in f.path.map { ($0, PersonPage.name($0, f.content ?? "")) } }
                .sorted { $0.1.localizedCaseInsensitiveCompare($1.1) == .orderedAscending }
            loaded = true
        }
    }
}

// MARK: - Daily notes

private struct DailyNotes: View {
    @Environment(World.self) private var world
    @State private var days: [(date: String, files: [(agentId: String, content: String)])] = []
    @State private var loaded = false
    @State private var limit = 7
    @State private var open: Set<String> = []

    /// `memory/<date>/<agentId>.md` as its date and agent id.
    static func parse(_ path: String) -> (date: String, agentId: String)? {
        let parts = path.components(separatedBy: "/")
        guard parts.count == 3, parts[0] == "memory", parts[2].hasSuffix(".md"),
              parts[1].range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else { return nil }
        return (parts[1], String(parts[2].dropLast(3)))
    }

    static func title(_ path: String) -> String { parse(path)?.date ?? path }

    var body: some View {
        List {
            if loaded && days.isEmpty {
                Section { Text("No daily notes yet.").foregroundStyle(Theme.fgMuted).listRowBackground(Theme.muted) }
            }
            Section {
                ForEach(days.prefix(limit), id: \.date) { day in
                    DisclosureGroup(isExpanded: Binding(get: { open.contains(day.date) }, set: { if $0 { open.insert(day.date) } else { open.remove(day.date) } })) {
                        ForEach(day.files, id: \.agentId) { file in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(world.agent(file.agentId)?.name ?? file.agentId).text(.xs, .medium).foregroundStyle(Theme.fgMuted)
                                Text(file.content).text(.base).foregroundStyle(Theme.fg).textSelection(.enabled)
                            }
                        }
                    } label: { Text(day.date).foregroundStyle(Theme.fg) }
                    .listRowBackground(Theme.muted)
                }
                ShowMore(shown: limit, total: days.count) { limit += 7 }.listRowBackground(Color.clear)
            } footer: { Text("What each agent wrote down during the day. Read-only.") }
        }
        .webGrouped()
        .overlay { if !loaded { ProgressView() } }
        .pageHeader("Daily notes")
        .task(id: world.homeRevision) {
            let files = (try? await world.homeFiles("memory/")) ?? []
            let parsed = files.compactMap { f in f.path.flatMap(Self.parse).map { (date: $0.date, agentId: $0.agentId, content: (f.content ?? "").trimmingCharacters(in: .whitespacesAndNewlines)) } }
            days = Dictionary(grouping: parsed, by: \.date).map { (date: $0.key, files: $0.value.map { ($0.agentId, $0.content) }) }
                .sorted { $0.date > $1.date }
            if open.isEmpty, let newest = days.first { open = [newest.date] }
            loaded = true
        }
    }
}

// MARK: - What I know and why

private struct ClaimsList: View {
    @Environment(World.self) private var world
    @State private var claims: [Contract.MemoryClaim] = []
    @State private var loaded = false
    @State private var selection: Set<String> = []
    @State private var editMode: EditMode = .inactive
    @State private var confirming = false
    @State private var isForgetting = false
    @State private var error: String?
    @State private var limit = 10
    @State private var historyLimit = 5

    private var active: [Contract.MemoryClaim] { claims.filter { $0.status == "active" } }
    private var history: [Contract.MemoryClaim] { claims.filter { $0.status != "active" } }
    private var chosen: [String] { selection.filter { id in active.contains { $0.id == id } } }

    var body: some View {
        List(selection: $selection) {
            Section {
                if loaded && active.isEmpty { Text("Nothing learned yet.").foregroundStyle(Theme.fgMuted).listRowBackground(Theme.muted) }
                ForEach(active.prefix(limit)) { claim in
                    ClaimRow(claim: claim)
                        .listRowBackground(Theme.muted)
                        .swipeActions { Button("Forget", role: .destructive) { selection = [claim.id]; confirming = true } }
                }
                ShowMore(shown: limit, total: active.count) { limit += 10 }.listRowBackground(Color.clear)
            } footer: { Text("What your agents concluded from what you said, with your own words as proof. Forgetting removes the claim and its lines from your memory files.") }
            if !history.isEmpty {
                Section {
                    DisclosureGroup("History (\(history.count))") {
                        ForEach(history.prefix(historyLimit)) { ClaimRow(claim: $0).opacity(0.7) }
                        ShowMore(shown: historyLimit, total: history.count) { historyLimit += 5 }
                    }
                    .foregroundStyle(Theme.fg)
                    .listRowBackground(Theme.muted)
                }
            }
            if let error { Section { Text(error).foregroundStyle(Theme.danger).listRowBackground(Theme.muted) } }
        }
        .webGrouped()
        .environment(\.editMode, $editMode)
        .overlay { if !loaded { ProgressView() } }
        .pageHeader("What I know and why")
        .toolbar {
            ToolbarItem(placement: .confirmationAction) { EditButton() }
            if editMode == .active && !chosen.isEmpty {
                ToolbarItem(placement: .bottomBar) {
                    Button("Forget \(chosen.count) selected", role: .destructive) { confirming = true }.disabled(isForgetting)
                }
            }
        }
        .confirmationDialog("Forget \(chosen.count) for good?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Forget", role: .destructive) { Task { await forget() } }
        }
        .task(id: world.homeRevision) { await load() }
    }

    @MainActor private func load() async {
        do {
            claims = try await world.memoryClaims()
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }

    @MainActor private func forget() async {
        isForgetting = true
        error = nil
        do {
            try await world.forgetMemory(chosen)
            selection = []
            editMode = .inactive
            await load()
        } catch {
            self.error = error.localizedDescription
        }
        isForgetting = false
    }
}

private struct ClaimRow: View {
    var claim: Contract.MemoryClaim

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(claim.text ?? "").text(.base).foregroundStyle(Theme.fg)
            if let evidence = claim.evidence?.first, let quote = evidence.quote {
                Text("“\(quote)”\(evidence.itemId?.hasPrefix("log:") == true ? " (from a daily note)" : "")")
                    .text(.sm).italic().foregroundStyle(Theme.fgMuted)
            }
            Text(caption).text(.xs).foregroundStyle(Theme.fgSubtle)
        }
    }

    private var caption: String {
        var parts: [String] = []
        if let confidence = claim.confidence { parts.append("\(Int((confidence * 100).rounded()))% sure") }
        if let target = claim.target, let path = target.path { parts.append(target.line.map { "\(path):\($0)" } ?? path) }
        if claim.createdAt != nil { parts.append(Fmt.ago(claim.createdAt)) }
        return parts.joined(separator: " · ")
    }
}
