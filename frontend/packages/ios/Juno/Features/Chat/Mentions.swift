import SwiftUI

/// @mentions in a group chat's composer. A room wakes only the agents a message mentions, so the composer
/// offers the members after an "@" and the message carries them (web lib/mentions.ts).
enum Mentions {
    static let aliases = ["all", "everyone"]

    /// The "@query" being typed at the end of the text (start of text or after whitespace), or nil.
    static func activeQuery(in text: String) -> String? {
        guard let at = text.lastIndex(of: "@") else { return nil }
        if at != text.startIndex, !text[text.index(before: at)].isWhitespace { return nil }
        let query = text[text.index(after: at)...]
        return query.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" }) ? String(query) : nil
    }

    /// The text with the "@query" at its end replaced by a finished "@handle ".
    static func completing(_ text: String, with handle: String) -> String {
        guard let at = text.lastIndex(of: "@") else { return text }
        return String(text[..<at]) + "@" + handle + " "
    }

    static func handle(for agent: Agent) -> String {
        let raw = agent.handle ?? agent.name ?? agent.id
        return raw.replacingOccurrences(of: "@", with: "").filter { !$0.isWhitespace }
    }

    /// Picker selections still present in the text, plus typed @all / @everyone; code spans never count.
    static func build(text: String, picked: [Mention]) -> [Mention] {
        let clean = stripCode(text)
        var seen = Set<String>(), out: [Mention] = []
        for token in tokens(in: clean) {
            let lower = token.lowercased()
            let mention = aliases.contains(lower)
                ? Mention(kind: "agent", id: lower, label: "@" + lower)
                : picked.first { $0.label.lowercased() == "@" + lower }
            if let mention, seen.insert(mention.id).inserted { out.append(mention) }
        }
        return out
    }

    /// "@token" words not glued to a preceding word character; trailing dots dropped.
    private static func tokens(in text: String) -> [String] {
        guard let re = try? NSRegularExpression(pattern: #"(?<![A-Za-z0-9_.])@([A-Za-z0-9_.-]+)"#) else { return [] }
        let ns = text as NSString
        return re.matches(in: text, range: NSRange(location: 0, length: ns.length)).compactMap {
            var t = ns.substring(with: $0.range(at: 1))
            while t.hasSuffix(".") { t.removeLast() }
            return t.isEmpty ? nil : t
        }
    }

    // MARK: Showing mentions in a sent or received message

    static let linkScheme = "juno-agent"

    static func link(_ id: String) -> URL? {
        var c = URLComponents(); c.scheme = linkScheme; c.host = "open"; c.queryItems = [URLQueryItem(name: "id", value: id)]
        return c.url
    }

    /// Tapping a mention opens that agent's card; any other link goes to the system.
    static func opener(world: World, from sourceId: String) -> OpenURLAction {
        OpenURLAction { url in
            guard url.scheme == linkScheme, let id = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "id" })?.value else { return .systemAction }
            world.openAgentPage(id, from: sourceId)
            return .handled
        }
    }

    /// Where each mentioned agent's current "@Name" stands in the text (code spans never count). A trailing line that is
    /// only "@Name" of an agent already named earlier is dropped (old messages repeated the mention there).
    /// `name` gives an agent id's current name.
    static func presenting(_ text: String, mentions: [Mention], name: (String) -> String?) -> (text: String, ranges: [(Range<String.Index>, String)]) {
        var names: [(id: String, handle: String)] = []
        for m in mentions where m.kind == "agent" {
            if let n = name(m.id), !n.isEmpty, !names.contains(where: { $0.id == m.id }) { names.append((m.id, "@" + n)) }
        }
        guard !names.isEmpty else { return (text, []) }
        var body = text
        let lines = body.components(separatedBy: "\n")
        if let end = lines.lastIndex(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }),
           let hit = names.first(where: { $0.handle.caseInsensitiveCompare(lines[end].trimmingCharacters(in: .whitespaces)) == .orderedSame }) {
            let before = lines[..<end].joined(separator: "\n")
            if before.range(of: hit.handle, options: .caseInsensitive) != nil {
                body = before.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        let alternatives = names.sorted { $0.handle.count > $1.handle.count }.map { NSRegularExpression.escapedPattern(for: $0.handle) }
        guard let re = try? NSRegularExpression(pattern: "(?<![\\p{L}\\p{N}_.@/])(" + alternatives.joined(separator: "|") + ")(?![\\p{L}\\p{N}_@-])", options: .caseInsensitive) else { return (body, []) }
        let whole = NSRange(location: 0, length: (body as NSString).length)
        var code: [NSRange] = []
        for pattern in ["```[\\s\\S]*?(```|$)", "`[^`\\n]*`?"] {
            if let c = try? NSRegularExpression(pattern: pattern) { code += c.matches(in: body, range: whole).map(\.range) }
        }
        var out: [(Range<String.Index>, String)] = []
        for m in re.matches(in: body, range: whole) {
            guard !code.contains(where: { NSIntersectionRange($0, m.range).length > 0 }), let r = Range(m.range, in: body) else { continue }
            let hit = String(body[r])
            if let id = names.first(where: { $0.handle.caseInsensitiveCompare(hit) == .orderedSame })?.id { out.append((r, id)) }
        }
        return (body, out)
    }

    /// Agent Markdown with each mention as a bold link to the agent (opened by `opener`).
    static func linking(_ text: String, mentions: [Mention], name: (String) -> String?) -> String {
        let (body, ranges) = presenting(text, mentions: mentions, name: name)
        var out = body
        for (range, id) in ranges.reversed() {
            out.replaceSubrange(range, with: "[**\(body[range])**](\(link(id)?.absoluteString ?? ""))")
        }
        return out
    }

    /// A user message's text with each mention bold and tappable.
    static func attributed(_ text: String, mentions: [Mention], name: (String) -> String?) -> AttributedString {
        let (body, ranges) = presenting(text, mentions: mentions, name: name)
        var out = AttributedString(body)
        for (range, id) in ranges {
            guard let lower = AttributedString.Index(range.lowerBound, within: out), let upper = AttributedString.Index(range.upperBound, within: out) else { continue }
            out[lower..<upper].inlinePresentationIntent = .stronglyEmphasized
            out[lower..<upper].link = link(id)
        }
        return out
    }

    private static func stripCode(_ text: String) -> String {
        var s = text
        for pattern in ["```[\\s\\S]*?(```|$)", "`[^`\\n]*`?"] {
            s = s.replacingOccurrences(of: pattern, with: " ", options: .regularExpression)
        }
        return s
    }
}

/// The suggestion list above the composer: "All" first, then the room's agents; scrolls when long.
struct MentionPicker: View {
    var agents: [Agent]
    var query: String
    var pick: (_ handle: String, _ mention: Mention) -> Void

    private var rows: [Agent] {
        let q = query.lowercased()
        return q.isEmpty ? agents : agents.filter { Mentions.handle(for: $0).lowercased().hasPrefix(q) || ($0.name ?? "").lowercased().hasPrefix(q) }
    }
    private var showAll: Bool { query.isEmpty || Mentions.aliases.contains { $0.hasPrefix(query.lowercased()) } }

    var body: some View {
        if showAll || !rows.isEmpty {
            ScrollView {
                VStack(spacing: 0) {
                    if showAll {
                        Button { pick("all", Mention(kind: "agent", id: "all", label: "@all")) } label: {
                            row { Image(systemName: "person.3.fill").foregroundStyle(Theme.fgMuted).frame(width: 28, height: 28) } title: { "All" } subtitle: { "Everyone in this chat" }
                        }
                        .accessibilityIdentifier("mention-all")
                    }
                    ForEach(rows) { agent in
                        Button {
                            let h = Mentions.handle(for: agent)
                            pick(h, Mention(kind: "agent", id: agent.id, label: "@" + h))
                        } label: {
                            row { AvatarView(agent: agent, size: 28) } title: { agent.name ?? agent.id } subtitle: { agent.title ?? "" }
                        }
                    }
                }
            }
            .frame(maxHeight: 220)
            .fixedSize(horizontal: false, vertical: true)
            .background(.regularMaterial, in: .rect(cornerRadius: 20))
        }
    }

    private func row<Lead: View>(@ViewBuilder lead: () -> Lead, title: () -> String, subtitle: () -> String) -> some View {
        HStack(spacing: 10) {
            lead()
            VStack(alignment: .leading, spacing: 0) {
                Text(title()).text(.sm, .medium).foregroundStyle(Theme.fg)
                let sub = subtitle()
                if !sub.isEmpty { Text(sub).text(.xs).foregroundStyle(Theme.fgMuted).lineLimit(1) }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .contentShape(.rect)
    }
}
