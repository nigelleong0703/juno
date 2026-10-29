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
