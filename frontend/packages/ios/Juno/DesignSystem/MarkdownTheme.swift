import SwiftUI
import Textual

// Agent messages render full Markdown with Textual (gonzalezreal's successor to MarkdownUI, which says it is in
// maintenance mode). Everything comes from Theme and the text scale: body text is the bubble's foreground, code
// sits on Theme.muted, table rules are Theme.border, and links keep the text colour (no system blue).

/// Renders one agent message body. Callers set the foreground colour and bubble; this only sets the text.
struct AgentMarkdown: View {
    var text: String

    var body: some View {
        StructuredText(markdown: Self.keepingEmptyCells(Self.normalizingProse(text)))
            .textual.structuredTextStyle(JunoMarkdownStyle())
            .text(.md)
    }
}

extension AgentMarkdown {
    /// Agent prose, made to read the way it was written: `•` / `·` / `‣` lines become list items, a single newline is
    /// a line break (chat-style), and a `**bold**` run next to CJK punctuation closes (CommonMark's flanking rules
    /// leave `**欧洲：**OpenAI` as literal asterisks; a hair space on the outside of the delimiter fixes it). Fenced
    /// code, code spans and table rows are left alone.
    static func normalizingProse(_ text: String) -> String {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var inFence = false
        var out: [String] = []
        for (i, raw) in lines.enumerated() {
            var line = raw
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") { inFence.toggle(); out.append(line); continue }
            if inFence { out.append(line); continue }
            if let first = trimmed.first, "•·‣".contains(first), trimmed.dropFirst().first == " " {
                line = "- " + trimmed.dropFirst(2)
            }
            line = closingBold(line)
            let next = i + 1 < lines.count ? lines[i + 1].trimmingCharacters(in: .whitespaces) : ""
            if !next.isEmpty, !trimmed.isEmpty, !trimmed.hasPrefix("|") { line += "  " }
            out.append(line)
        }
        return out.joined(separator: "\n")
    }

    private static func isPunct(_ c: Character) -> Bool {
        c.unicodeScalars.allSatisfy { CharacterSet.punctuationCharacters.contains($0) || CharacterSet.symbols.contains($0) }
    }

    /// Adds U+200A outside a `**…**` pair whose inside edge is punctuation and whose outside neighbour is a letter.
    private static func closingBold(_ line: String) -> String {
        guard line.contains("**") else { return line }
        let hair = "\u{200A}"
        var result = ""
        for (index, part) in line.components(separatedBy: "`").enumerated() {
            if index % 2 == 1 { result += "`" + part + "`"; continue }   // inside a code span
            var segment = part
            let pattern = try! NSRegularExpression(pattern: #"\*\*([^*]+?)\*\*"#)
            let matches = pattern.matches(in: segment, range: NSRange(segment.startIndex..., in: segment)).reversed()
            for m in matches {
                guard let whole = Range(m.range, in: segment), let inner = Range(m.range(at: 1), in: segment) else { continue }
                let isLetter: (Character) -> Bool = { !$0.isWhitespace && !isPunct($0) }
                if let last = segment[inner].last, isPunct(last), let after = segment[whole.upperBound...].first, isLetter(after) {
                    segment.insert(contentsOf: hair, at: whole.upperBound)
                }
                if let first = segment[inner].first, isPunct(first), let before = segment[..<whole.lowerBound].last, isLetter(before) {
                    segment.insert(contentsOf: hair, at: whole.lowerBound)
                }
            }
            result += segment
        }
        return result
    }
    /// The parser drops an empty table cell, which shifts a header like `| | A | B |` one column left. A
    /// non-breaking space keeps the cell (and its column) in every row.
    static func keepingEmptyCells(_ text: String) -> String {
        guard text.contains("|") else { return text }
        var inFence = false
        return text.split(separator: "\n", omittingEmptySubsequences: false).map { line -> String in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") { inFence.toggle() }
            guard !inFence, trimmed.hasPrefix("|") else { return String(line) }
            var cells = trimmed.dropFirst().split(separator: "|", omittingEmptySubsequences: false).map(String.init)
            if trimmed.hasSuffix("|") { cells.removeLast() }
            let isRule = cells.allSatisfy { $0.allSatisfy { " -:".contains($0) } }
            if isRule { return String(line) }
            return "|" + cells.map { $0.trimmingCharacters(in: .whitespaces).isEmpty ? " \u{00A0} " : $0 }.joined(separator: "|") + "|"
        }.joined(separator: "\n")
    }
}

struct JunoMarkdownStyle: StructuredText.Style {
    private let base = StructuredText.DefaultStyle()

    var inlineStyle: InlineStyle {
        InlineStyle()
            .code(.monospaced, .fontScale(0.9), .backgroundColor(Theme.muted))
            .link(.foregroundColor(Theme.fg), .underlineStyle(.single))
            .strong(.fontWeight(.semibold))
    }
    var headingStyle: JunoHeadingStyle { JunoHeadingStyle() }
    var paragraphStyle: StructuredText.DefaultParagraphStyle { base.paragraphStyle }
    var blockQuoteStyle: StructuredText.DefaultBlockQuoteStyle { base.blockQuoteStyle }
    var codeBlockStyle: JunoCodeBlockStyle { JunoCodeBlockStyle() }
    var listItemStyle: StructuredText.DefaultListItemStyle { base.listItemStyle }
    var unorderedListMarker: StructuredText.SymbolListMarker { base.unorderedListMarker }
    var orderedListMarker: StructuredText.DecimalListMarker { base.orderedListMarker }
    var tableStyle: JunoTableStyle { JunoTableStyle() }
    var tableCellStyle: StructuredText.DefaultTableCellStyle { base.tableCellStyle }
    var thematicBreakStyle: StructuredText.DividerThematicBreakStyle { base.thematicBreakStyle }
}

/// Headings: the body size scaled up for H1-H2, semibold throughout, no colour change.
struct JunoHeadingStyle: StructuredText.HeadingStyle {
    private static let scales: [CGFloat] = [1.3, 1.15, 1, 1, 1, 1]

    func makeBody(configuration: Configuration) -> some View {
        let level = min(max(configuration.headingLevel, 1), 6)
        configuration.label
            .textual.fontScale(Self.scales[level - 1])
            .textual.blockSpacing(.fontScaled(top: 1, bottom: 0.4))
            .fontWeight(.semibold)
    }
}

/// Fenced code: monospaced, Theme.muted surface, hairline Theme.border, scrolls sideways instead of wrapping.
struct JunoCodeBlockStyle: StructuredText.CodeBlockStyle {
    func makeBody(configuration: Configuration) -> some View {
        Overflow {
            configuration.label
                .textual.lineSpacing(.fontScaled(0.39))
                .textual.fontScale(0.882)
                .fixedSize(horizontal: false, vertical: true)
                .monospaced()
                .padding(.vertical, 8)
                .padding(.horizontal, 12)
        }
        .background(Theme.muted)
        .clipShape(RoundedRectangle(cornerRadius: Radius.sm, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.sm, style: .continuous).stroke(Theme.border, lineWidth: 1))
        .textual.blockSpacing(.fontScaled(top: 0.88, bottom: 0))
    }
}

/// Tables: a Theme.border grid drawn over the cells (the same layout pass as Textual's default table).
struct JunoTableStyle: StructuredText.TableStyle {
    private static let rule: CGFloat = 1

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .textual.tableCellSpacing(horizontal: Self.rule, vertical: Self.rule)
            .textual.blockSpacing(.fontScaled(top: 1.6, bottom: 1.6))
            .textual.tableOverlay { layout in
                // One hairline per gap, centred in it, however wide the grid made the gap.
                Canvas { context, _ in
                    for divider in layout.horizontalDividers() {
                        context.fill(Path(CGRect(x: divider.minX, y: divider.midY - Self.rule / 2, width: divider.width, height: Self.rule)), with: .color(Theme.border))
                    }
                    for divider in layout.verticalDividers() {
                        context.fill(Path(CGRect(x: divider.midX - Self.rule / 2, y: divider.minY, width: Self.rule, height: divider.height)), with: .color(Theme.border))
                    }
                }
            }
            .padding(Self.rule)
    }
}
