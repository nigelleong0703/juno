import SwiftUI

/// What the Chats list tells its bar: how far the list has scrolled (the bar's "Chats" title and the pinned chips follow it)
/// and whether the chips are stuck to the bar. Today itself is its own tab (owner-approved 2026-10-26).
@Observable final class TodayLayout {
    var scroll: CGFloat = 0
    /// The chips header is stuck to the bar (it has left its place in the list).
    var chipsPinned = false
}

/// HOW a suggestion is done, from what it asks and does: the icon and the "uses your …" line.
private enum InspirationKind {
    case mail, web, calendar, doc, generic

    init(_ card: TodaySummary.Inspiration) {
        if case .unlock = card.action { self = .generic; return }
        let text = [card.prompt, card.title, card.reason].compactMap { $0 }.joined(separator: " ").lowercased()
        func has(_ words: [String]) -> Bool { words.contains { text.contains($0) } }
        if has(["email", "e-mail", "mail", "inbox", "gmail"]) { self = .mail }
        else if has(["calendar", "meeting", "schedule", "appointment"]) { self = .calendar }
        else if has(["document", "draft", "report", "spreadsheet", "slides", "notes", "write up"]) { self = .doc }
        else if has(["web", "browse", "website", "search", "research", "look up", "online", "price", "flight", "news"]) { self = .web }
        else { self = .generic }
    }

    var symbol: String {
        switch self {
        case .mail: "envelope"
        case .web: "globe"
        case .calendar: "calendar"
        case .doc: "doc.text"
        case .generic: "sparkles"
        }
    }

    var uses: String? {
        switch self {
        case .mail: "uses your email"
        case .web: "browses the web"
        case .calendar: "uses your calendar"
        case .doc: "writes a document"
        case .generic: nil
        }
    }
}

/// The 32pt rounded square with an SF Symbol on a faint tint.
private struct InspirationTile: View {
    var symbol: String
    var tint: Color
    var body: some View {
        Image(systemName: symbol).font(.system(size: 15, weight: .medium)).foregroundStyle(tint)
            .frame(width: 32, height: 32)
            .background(tint.opacity(0.14), in: .rect(cornerRadius: 8))
    }
}

struct CardButton: Identifiable {
    enum Kind { case primary, ghost, link }
    enum Label { case start, notNow, doIt, draft }
    var label: String
    var kind: Kind = .primary
    var run: () -> Void
    var id: String { label }

    /// Start / Not now / Do it, in Chinese when the card's own text is (the web's `cardLabel`).
    static func label(_ key: Label, for text: String) -> String {
        let cjk = text.unicodeScalars.contains { (0x3040...0x30FF).contains($0.value) || (0x3400...0x9FFF).contains($0.value) || (0xAC00...0xD7AF).contains($0.value) }
        switch key {
        case .start: return cjk ? "开始" : "Start"
        case .notNow: return cjk ? "以后再说" : "Not now"
        case .doIt: return cjk ? "去做" : "Do it"
        case .draft: return cjk ? "草稿" : "Draft"
        }
    }
}

/// An idea or a suggestion as one compact card in the Feed's language: the leading icon or avatar, the title (up to two
/// lines), one muted line, then a chevron (an idea: the whole card opens it) or, for a suggestion, one explicit button
/// at the bottom right (the card body does nothing, so a mis-tap while scrolling starts nothing).
struct SuggestionCard<Leading: View>: View {
    var title: String
    var subtitle: String
    /// The card's explicit buttons, bottom row (a `.link` first at the left, then the rest at the right); empty keeps a chevron.
    var buttons: [CardButton] = []
    var fillsHeight = false
    /// An extra control at the left of the button row (an idea's "Less like this" menu).
    var extra: AnyView?
    @ViewBuilder var leading: Leading

    var body: some View {
        VStack(alignment: .trailing, spacing: 12) {
            HStack(spacing: 12) {
                leading
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).text(.md, .semibold).foregroundStyle(Theme.fg).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    if !subtitle.isEmpty { Text(subtitle).text(.sm).foregroundStyle(Theme.fgMuted).lineLimit(1) }
                }
                Spacer(minLength: 0)
                if buttons.isEmpty { Image(systemName: "chevron.right").text(.xs, .semibold).foregroundStyle(Theme.fgSubtle) }
            }
            if fillsHeight { Spacer(minLength: 0) }
            if !buttons.isEmpty {
                HStack(spacing: 12) {
                    ForEach(buttons.filter { $0.kind == .link }) { b in
                        Button(b.label, action: b.run).text(.sm).foregroundStyle(Theme.fgMuted).frame(minHeight: 32)
                    }
                    if let extra { extra }
                    Spacer(minLength: 0)
                    ForEach(buttons.filter { $0.kind != .link }) { b in
                        Button(b.label, action: b.run).buttonStyle(WebButton(variant: b.kind == .primary ? .primary : .ghost, size: .sm))
                    }
                }
            }
        }
        .frame(maxHeight: fillsHeight ? .infinity : nil, alignment: .top)
        .feedCard()
        .contentShape(.rect)
    }
}

/// The connector's brand logo when the app has one, else a puzzle piece.
private struct UnlockTile: View {
    @Environment(World.self) private var world
    var action: TodaySummary.Action
    var body: some View {
        if case .unlock(let target, let connectorId, _) = action {
            switch target {
            case "connector":
                BrandIcon(catalogId: connectorId, symbol: "puzzlepiece.extension", size: 32)
            case "computer": InspirationTile(symbol: "desktopcomputer", tint: Theme.fgMuted)
            default: InspirationTile(symbol: "person.crop.circle", tint: Theme.fgMuted)
            }
        }
    }
}

/// One suggestion: the tile or avatar, the prompt in the user's voice, who does it and with what, and one button
/// ("Start", or the unlock card's own label). Only the button acts.
struct InspirationRow: View {
    @Environment(World.self) private var world
    var card: TodaySummary.Inspiration
    /// In the carousel every card takes the height of the tallest.
    var fillsHeight = false

    var body: some View {
        let kind = InspirationKind(card)
        let agent = card.agentId.flatMap { world.agent($0) }
        let tint = agent.map { agentTint($0) } ?? Theme.fgMuted
        var title = card.title
        var label = CardButton.label(.start, for: "\(card.title) \(card.prompt ?? "")")
        var subtitle = [agent?.name, kind.uses ?? (agent == nil ? card.reason : nil)].compactMap { $0 }.joined(separator: " \u{00B7} ")
        var unlock = false
        if case .unlock = card.action {
            // The title is the benefit and the prompt the button label.
            unlock = true
            label = card.prompt ?? "Set up"
            subtitle = card.reason ?? ""
        }
        return SuggestionCard(title: title, subtitle: subtitle, buttons: [CardButton(label: label) { world.perform(card) }], fillsHeight: fillsHeight) {
            // Same leading as an idea card: the agent who will do it; the tile only when no agent is picked yet.
            if unlock { UnlockTile(action: card.action) }
            else if let agent { AvatarView(agent: agent, size: AvatarSize.md) } else { InspirationTile(symbol: kind.symbol, tint: tint) }
        }
        .accessibilityIdentifier("today-inspiration-\(card.id)")
    }
}
