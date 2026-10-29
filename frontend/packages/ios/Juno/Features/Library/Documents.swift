import Foundation

// MARK: - Documents (contracts 0.70, BACKEND §5.11a; web: components/document/)
// A document is a Library row with `render == "doc"`. An agent's change is a draft the owner approves or declines; the owner's
// own save is an approval. These are the wire shapes the viewer needs, and the pure pieces: the editor page's bridge
// messages and the block diff of the review.

/// Who wrote a draft: an agent (`{agentId}`) or the owner (`"person"`).
enum DocAuthor: Decodable, Hashable {
    case person
    case agent(String)

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if (try? c.decode(String.self)) != nil { self = .person; return }
        struct Agent: Decodable { var agentId: String }
        self = .agent(try c.decode(Agent.self).agentId)
    }

    var agentId: String? { if case .agent(let id) = self { id } else { nil } }
}

struct DocDraft: Decodable, Hashable, Identifiable {
    var id: String
    var documentId: String?
    var baseVersion: Int?
    var revision: Int
    var title: String?
    var summary: String?
    var author: DocAuthor?
    var status: String?

    /// Still waiting for a decision.
    var isOpen: Bool { status == "pending" }
}

/// `GET /v1/documents/:id`: the document and its open draft. `target` is the external copy (Google Docs, Notion) approval writes to.
struct DocView: Decodable, Hashable {
    var document: LibraryItem
    var draft: DocDraft?
    var target: DocTarget?

    enum CodingKeys: String, CodingKey { case document, draft }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        document = try c.decode(LibraryItem.self, forKey: .document)
        draft = try c.decodeIfPresent(DocDraft.self, forKey: .draft)
        struct Row: Decodable { var target: DocTarget? }
        target = try c.decode(Row.self, forKey: .document).target
    }

    /// The saved head version (0 until the first approval).
    var headVersion: Int { document.version ?? 0 }
    var openDraft: DocDraft? { draft.flatMap { $0.isOpen ? $0 : nil } }
}

struct DocTarget: Decodable, Hashable {
    var appId: String
    var externalId: String?
    var url: String?
}

/// `GET`/`PUT …/draft`: the draft and its Markdown.
struct DocDraftBody: Decodable {
    var draft: DocDraft
    var markdown: String
}

struct DocVersionBody: Decodable { var version: Int; var markdown: String }

// MARK: - The editor page's bridge (packages/doc-editor/src/bridge.ts)

/// Formatting actions the native bar can ask the page for.
enum EditorCommand: String, CaseIterable {
    case bold, italic, strike, code, heading1, heading2, heading3, paragraph
    case bulletList, orderedList, taskList, blockquote, codeBlock, table, rule, link, undo, redo
}

/// What the page tells the app (`WKScriptMessageHandler` named `junoEditor`).
enum EditorEvent: Equatable {
    case ready
    /// `rich`, or `source` when the Markdown would not survive the rich editor.
    case mode(String)
    case change(String)
    case state([String: Bool])

    static func parse(_ body: Any) -> EditorEvent? {
        guard let message = body as? [String: Any], let type = message["type"] as? String else { return nil }
        switch type {
        case "ready": return .ready
        case "mode": return (message["mode"] as? String).map(EditorEvent.mode)
        case "change": return (message["markdown"] as? String).map(EditorEvent.change)
        case "state": return (message["state"] as? [String: Bool]).map(EditorEvent.state)
        default: return nil
        }
    }
}

/// The scripts the app runs in the page: one `junoEditor.receive(<json>)` call per message, the text always JSON-escaped.
enum EditorScript {
    static func setMarkdown(_ markdown: String) -> String { receive(["type": "setMarkdown", "markdown": markdown]) }
    static func setEditable(_ editable: Bool) -> String { receive(["type": "setEditable", "editable": editable]) }
    static func command(_ command: EditorCommand, argument: String? = nil) -> String {
        var message: [String: Any] = ["type": "command", "command": command.rawValue]
        if let argument { message["argument"] = argument }
        return receive(message)
    }

    private static func receive(_ message: [String: Any]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: message)) ?? Data("{}".utf8)
        return "junoEditor.receive(\(String(decoding: data, as: UTF8.self)))"
    }
}

// MARK: - Review diff (packages/doc-editor/src/blockDiff.ts)

struct DiffBlock: Equatable {
    enum Kind { case same, added, removed }
    var kind: Kind
    var text: String
}

enum BlockDiff {
    /// Blocks are the parts between blank lines; a fenced code block stays whole.
    static func blocks(_ markdown: String) -> [String] {
        var out: [String] = []
        var current: [String] = []
        var fenced = false
        for line in markdown.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") { fenced.toggle() }
            if !fenced && trimmed.isEmpty {
                if !current.isEmpty { out.append(current.joined(separator: "\n")); current = [] }
            } else {
                current.append(String(line))
            }
        }
        if !current.isEmpty { out.append(current.joined(separator: "\n")) }
        return out
    }

    /// What the draft adds to and removes from the saved version (longest common subsequence of blocks).
    static func diff(saved: String, draft: String) -> [DiffBlock] {
        let a = blocks(saved), b = blocks(draft)
        var lcs = Array(repeating: Array(repeating: 0, count: b.count + 1), count: a.count + 1)
        for i in stride(from: a.count - 1, through: 0, by: -1) {
            for j in stride(from: b.count - 1, through: 0, by: -1) {
                lcs[i][j] = a[i] == b[j] ? lcs[i + 1][j + 1] + 1 : max(lcs[i + 1][j], lcs[i][j + 1])
            }
        }
        var out: [DiffBlock] = []
        var i = 0, j = 0
        while i < a.count || j < b.count {
            if i < a.count, j < b.count, a[i] == b[j] {
                out.append(DiffBlock(kind: .same, text: a[i])); i += 1; j += 1
            } else if j < b.count, i == a.count || lcs[i][j + 1] >= lcs[i + 1][j] {
                out.append(DiffBlock(kind: .added, text: b[j])); j += 1
            } else {
                out.append(DiffBlock(kind: .removed, text: a[i])); i += 1
            }
        }
        return out
    }
}
