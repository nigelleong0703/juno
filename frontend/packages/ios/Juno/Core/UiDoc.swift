import Foundation

// Juno UI blocks (BACKEND 8.7.1): the small component standard the agent emits and the clients draw. The wire doc is kept
// as raw JSON and parsed block by block, so one block this app does not know (or cannot read) never loses the card:
// the doc then shows the server-written `text`. The generated `Contract.UiDoc` is not used for decoding on purpose.

struct UiDoc: Codable, Hashable, Sendable {
    var raw: JSONValue

    init(raw: JSONValue) { self.raw = raw }
    /// Never throws: whatever arrives is kept, and `blocks` / `isRenderable` say what can be drawn.
    init(from decoder: Decoder) throws { raw = (try? JSONValue(from: decoder)) ?? .null }
    func encode(to encoder: Encoder) throws { try raw.encode(to: encoder) }

    var title: String? { raw["title"]?.string }
    /// The plain-text fallback the server wrote (`uiDocToText`).
    var text: String? { raw["text"]?.string }
    var blocks: [UiBlock] { raw["blocks"]?.array?.map(UiBlock.parse) ?? [] }
    /// False for an unknown version, an empty doc, or any block of a type (or shape) this app cannot draw.
    var isRenderable: Bool {
        guard raw["version"]?.number == 1 else { return false }
        let all = blocks
        return !all.isEmpty && all.allSatisfy { $0.isKnown }
    }
    var interactive: UiBlock? { blocks.first { $0.isInteractive } }
    /// The headline: the title, else the doc's first line of text.
    var headline: String? {
        if let title, !title.isEmpty { return title }
        return text?.split(separator: "\n").first.map(String.init)
    }
}

struct UiFact: Hashable, Sendable { var label: String; var value: String; var emphasis = false }
struct UiItemRow: Hashable, Sendable {
    var name: String; var detail: String?; var quantity: Int?; var price: String?; var imageUrl: URL?
}
struct UiChoiceOption: Hashable, Sendable, Identifiable {
    var id: String; var label: String; var style: String; var description: String?
}
struct UiChoices: Hashable, Sendable { var id: String; var options: [UiChoiceOption]; var multiple: Bool }
struct UiField: Hashable, Sendable, Identifiable {
    var id: String; var label: String; var kind: String; var options: [String]; var required: Bool; var placeholder: String?
}
struct UiFields: Hashable, Sendable { var id: String; var fields: [UiField] }

indirect enum UiBlock: Hashable, Sendable {
    case text(String)
    case facts([UiFact])
    case items(rows: [UiItemRow], total: UiFact?)
    case table(columns: [String], rows: [[String]])
    case notice(tone: String, text: String)
    case link(url: URL, title: String, subtitle: String?)
    case image(libraryId: String, caption: String?)
    case group(title: String?, blocks: [UiBlock])
    case replies([String])
    case choices(UiChoices)
    case fields(UiFields)
    case unknown

    var isKnown: Bool {
        switch self {
        case .unknown: false
        case .group(_, let inner): inner.allSatisfy { $0.isKnown && !$0.isInteractive }
        default: true
        }
    }
    var isInteractive: Bool {
        switch self { case .choices, .fields: true; default: false }
    }

    static func parse(_ json: JSONValue) -> UiBlock {
        guard let type = json["type"]?.string else { return .unknown }
        func str(_ key: String) -> String? { json[key]?.string.flatMap { $0.isEmpty ? nil : $0 } }
        switch type {
        case "text":
            return str("text").map(UiBlock.text) ?? .unknown
        case "facts":
            guard let rows = json["rows"]?.array else { return .unknown }
            let facts = rows.compactMap(fact)
            return facts.count == rows.count && !facts.isEmpty ? .facts(facts) : .unknown
        case "items":
            guard let rows = json["rows"]?.array else { return .unknown }
            let parsed: [UiItemRow] = rows.compactMap { row in
                guard let name = row["name"]?.string else { return nil }
                return UiItemRow(name: name, detail: row["detail"]?.string, quantity: row["quantity"]?.number.map { Int($0) },
                                 price: row["price"]?.string, imageUrl: row["imageUrl"]?.string.flatMap(httpsURL))
            }
            guard parsed.count == rows.count, !parsed.isEmpty else { return .unknown }
            return .items(rows: parsed, total: json["total"].flatMap(fact))
        case "table":
            guard let columns = json["columns"]?.array?.compactMap(\.string), columns.count >= 2,
                  let rows = json["rows"]?.array else { return .unknown }
            // A short row is padded and a long one cut, so a table never fails on one ragged row.
            let cells = rows.compactMap { $0.array }.map { row in (0..<columns.count).map { $0 < row.count ? (row[$0].string ?? "") : "" } }
            return cells.isEmpty ? .unknown : .table(columns: columns, rows: cells)
        case "notice":
            guard let tone = json["tone"]?.string, ["info", "warning", "success"].contains(tone), let text = str("text") else { return .unknown }
            return .notice(tone: tone, text: text)
        case "link":
            guard let url = str("url").flatMap(httpsURL), let title = str("title") else { return .unknown }
            return .link(url: url, title: title, subtitle: str("subtitle"))
        case "image":
            return str("libraryId").map { .image(libraryId: $0, caption: str("caption")) } ?? .unknown
        case "group":
            guard let inner = json["blocks"]?.array?.map(parse), !inner.isEmpty else { return .unknown }
            return .group(title: str("title"), blocks: inner)
        case "replies":
            let options = json["options"]?.array?.compactMap(\.string) ?? []
            return options.isEmpty ? .unknown : .replies(Array(options.prefix(3)))
        case "choices":
            guard let id = str("id"), let raw = json["options"]?.array else { return .unknown }
            let options: [UiChoiceOption] = raw.compactMap { option in
                guard let id = option["id"]?.string, let label = option["label"]?.string else { return nil }
                return UiChoiceOption(id: id, label: label, style: option["style"]?.string ?? "default", description: option["description"]?.string)
            }
            return options.count == raw.count && options.count >= 2 ? .choices(UiChoices(id: id, options: options, multiple: json["multiple"]?.bool == true)) : .unknown
        case "fields":
            guard let id = str("id"), let raw = json["fields"]?.array else { return .unknown }
            let fields: [UiField] = raw.compactMap { field in
                guard let id = field["id"]?.string, let label = field["label"]?.string, let kind = field["kind"]?.string,
                      ["text", "number", "date", "select"].contains(kind) else { return nil }
                let options = field["options"]?.array?.compactMap(\.string) ?? []
                if kind == "select", options.isEmpty { return nil }
                return UiField(id: id, label: label, kind: kind, options: options, required: field["required"]?.bool != false,
                               placeholder: field["placeholder"]?.string)
            }
            return fields.count == raw.count && !fields.isEmpty ? .fields(UiFields(id: id, fields: fields)) : .unknown
        default:
            return .unknown
        }
    }

    private static func fact(_ json: JSONValue) -> UiFact? {
        guard let label = json["label"]?.string, let value = json["value"]?.string else { return nil }
        return UiFact(label: label, value: value, emphasis: json["emphasis"]?.bool == true)
    }
    private static func httpsURL(_ s: String) -> URL? { s.hasPrefix("https://") ? URL(string: s) : nil }
}

extension JSONValue {
    subscript(key: String) -> JSONValue? { if case .object(let o) = self { o[key] } else { nil } }
    var string: String? { if case .string(let s) = self { s } else { nil } }
    var number: Double? { if case .number(let n) = self { n } else { nil } }
    var bool: Bool? { if case .bool(let b) = self { b } else { nil } }
    var array: [JSONValue]? { if case .array(let a) = self { a } else { nil } }
}

// MARK: - Answers

/// Answers are strings keyed by id, checked with the same rules as the server's `validateUiAnswers`.
enum UiAnswers {
    /// Choices: key = block id, value = the option id, or a JSON array string of ids when `multiple`.
    static func encodeChoice(_ ids: [String]) -> String { String(data: (try? JSONEncoder().encode(ids)) ?? Data(), encoding: .utf8) ?? "[]" }
    static func decodeChoice(_ value: String?, multiple: Bool) -> [String] {
        guard let value, !value.isEmpty else { return [] }
        guard multiple else { return [value] }
        return (try? JSONDecoder().decode([String].self, from: Data(value.utf8))) ?? []
    }

    /// The reason a field's value is not acceptable, or nil. Empty is fine unless required.
    static func problem(_ field: UiField, _ raw: String) -> String? {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return field.required ? "Required" : nil }
        switch field.kind {
        case "number": return value.range(of: #"^-?\d+(\.\d+)?$"#, options: .regularExpression) == nil ? "Enter a number" : nil
        case "date": return isRealDate(value) ? nil : "Enter a date as YYYY-MM-DD"
        case "select": return field.options.contains(value) ? nil : "Pick one"
        default: return value.count > 1000 ? "Must be at most 1000 characters" : nil
        }
    }

    static func problems(_ fields: UiFields, _ values: [String: String]) -> [String: String] {
        Dictionary(uniqueKeysWithValues: fields.fields.compactMap { f in problem(f, values[f.id] ?? "").map { (f.id, $0) } })
    }

    /// The answers to send: trimmed, empty optionals left out.
    static func payload(_ fields: UiFields, _ values: [String: String]) -> [String: String] {
        var out: [String: String] = [:]
        for f in fields.fields {
            let v = (values[f.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !v.isEmpty { out[f.id] = v }
        }
        return out
    }

    static func parseDate(_ s: String) -> Date? { isRealDate(s) ? formatter.date(from: s) : nil }
    static func formatDate(_ d: Date) -> String { formatter.string(from: d) }
    private static let formatter: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd"; return f
    }()
    private static func isRealDate(_ s: String) -> Bool {
        guard s.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil, let d = formatter.date(from: s) else { return false }
        return formatter.string(from: d) == s
    }

    /// A decided question as one line: the labels of the picked options, or the typed values.
    static func summary(_ doc: UiDoc, _ answers: [String: String]?) -> String {
        guard let answers, let block = doc.interactive else { return "" }
        switch block {
        case .choices(let c):
            let picked = decodeChoice(answers[c.id], multiple: c.multiple)
            return c.options.filter { picked.contains($0.id) }.map(\.label).joined(separator: ", ")
        case .fields(let f): return f.fields.compactMap { answers[$0.id] }.joined(separator: ", ")
        default: return ""
        }
    }
}
