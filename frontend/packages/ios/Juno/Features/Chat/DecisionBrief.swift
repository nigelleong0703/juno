import SwiftUI

// A request's decision brief in words: category names and symbols, the consequences worth a glance, the outcome
// words of a decided request, and the limits of a delegation. The card, the Permissions history and the
// authority table all read from here.

enum DecisionWords {
    /// The small badge on a card or row.
    static func badge(_ category: String?) -> String {
        switch category {
        case "spending": "Spending"
        case "speaking": "Speaking"
        case "public": "Public"
        case "committing": "Commits you"
        case "irreversible": "Can't be undone"
        case "sensitive": "Sensitive"
        case "sharing": "Share between chats"
        case "setup": "Setup"
        case "choice": "Your choice"
        default: "Decision"
        }
    }

    /// The row name in the authority table.
    static func name(_ category: String?) -> String {
        category == "committing" ? "Committing" : category == "choice" ? "Your choice" : badge(category)
    }

    static func symbol(_ category: String?) -> String {
        switch category {
        case "spending": "creditcard"
        case "speaking": "text.bubble"
        case "public": "megaphone"
        case "committing": "calendar.badge.checkmark"
        case "irreversible": "trash"
        case "sensitive": "lock"
        case "sharing": "square.and.arrow.up"
        case "setup": "gearshape"
        case "choice": "list.bullet"
        default: "hand.raised"
        }
    }

    /// Categories an agent can be given authority over; the rest always ask.
    static let delegable = ["spending", "speaking", "committing", "public", "sharing"]
    static let alwaysAsk = ["irreversible", "sensitive", "setup", "choice"]

    /// Why a category always asks, as the right-hand text of its muted row.
    static func alwaysAsksNote(_ category: String) -> String { category == "choice" ? "Your decision" : "Always asks" }

    /// The server's `Request.outcome` in words; nil for a value this app does not know.
    static func outcome(_ outcome: String?) -> String? {
        switch outcome {
        case "allowed_once": "Allowed once"
        case "allowed_rule": "Allowed by your rule"
        case "denied": "Denied"
        case "revised": "Sent back to change"
        case "timed_out": "Timed out"
        case "cancelled": "Cancelled"
        case "handed_back": "Handed back"
        default: nil
        }
    }

    static func outcomeTone(_ outcome: String?) -> CardOutcome {
        switch outcome {
        case "allowed_once", "allowed_rule": .done
        case "denied", "revised": .refused
        default: .neutral
        }
    }
}

/// One line of what the decision costs or risks; a `declared` fact is only what the agent says.
struct Consequence: Hashable {
    var symbol: String
    var text: String
    var declared: Bool
}

extension Contract.DecisionBrief {
    /// Primary first, then the others; at most two badges.
    var badges: [String] {
        var all = [primary].compactMap { $0 }
        for c in categories ?? [] where !all.contains(c) { all.append(c) }
        return Array(all.prefix(2))
    }

    /// The heaviest facts, at most three.
    var consequences: [Consequence] {
        var out: [Consequence] = []
        guard let f = facts else { return out }
        func declared(_ source: String?) -> Bool { source == "declared" }
        if let r = f.reversible, r.value == "no" || r.value == "hard" {
            out.append(Consequence(symbol: "exclamationmark.triangle", text: r.value == "no" ? "Can't be undone" : "Hard to undo", declared: declared(r.source)))
        }
        if let m = f.money, let amount = Money.text(m.amount, m.currency) {
            let every = ["weekly": "week", "monthly": "month", "yearly": "year"][m.recurring ?? ""].map { " / \($0)" } ?? ""
            out.append(Consequence(symbol: "creditcard", text: amount + every + (m.merchant.map { " at \($0)" } ?? ""), declared: declared(m.source)))
        }
        if let s = f.sensitive?.first {
            out.append(Consequence(symbol: "lock", text: s.label ?? "Sensitive details", declared: declared(s.source)))
        }
        if let c = f.commitments?.first, let text = c.text {
            out.append(Consequence(symbol: "calendar", text: "Commits: \(text)", declared: declared(c.source)))
        }
        if let a = f.audience, let text = Self.audienceText(a) {
            out.append(Consequence(symbol: "person.2", text: text, declared: declared(a.source)))
        }
        if let a = f.asAccount, let label = a.label {
            out.append(Consequence(symbol: "person.crop.circle", text: "As \(label)", declared: declared(a.source)))
        }
        return Array(out.prefix(3))
    }

    private static func audienceText(_ a: Contract.DecisionFacts.Audience) -> String? {
        if a.kind == "public" { return "Anyone can see it" }
        let names = (a.recipients ?? []).compactMap { $0.name ?? $0.address }
        if !names.isEmpty {
            let more = max((a.count ?? names.count) - 2, 0)
            return "To " + names.prefix(2).joined(separator: ", ") + (more > 0 ? " +\(more)" : "")
        }
        if a.kind == "room" { return "To the room" }
        return a.count.map { "To \($0) \($0 == 1 ? "person" : "people")" }
    }

    /// The one consequence a history row shows: the amount, who it reached, how many things it touched.
    var keyConsequence: String? {
        if let m = facts?.money, let amount = Money.text(m.amount, m.currency) { return amount }
        if let a = facts?.audience {
            if a.kind == "public" { return "Public" }
            if let n = a.count, n > 1 { return "to \(n) people" }
            if let name = a.recipients?.first.flatMap({ $0.name ?? $0.address }) { return "to \(name)" }
        }
        if let targets = facts?.targets, !targets.isEmpty {
            let n = targets.reduce(0) { $0 + ($1.count ?? 1) }
            return n == 1 ? targets[0].label : "\(n) items"
        }
        return consequences.first?.text
    }
}

enum Money {
    /// "$30.00", or "$30" with `whole` when there are no cents. nil when the amount does not parse.
    static func text(_ amount: String?, _ currency: String?, whole: Bool = false) -> String? {
        guard let amount, let value = Decimal(string: amount) else { return nil }
        let isWhole = (value as NSDecimalNumber).doubleValue.rounded() == (value as NSDecimalNumber).doubleValue
        return value.formatted(.currency(code: currency ?? "USD").precision(.fractionLength(whole && isWhole ? 0 : 2)))
    }
}

extension AgentRequest {
    /// What the agent wants, in one sentence: the brief's, else the request's own title.
    var sentence: String {
        if let s = payload?.brief?.sentence, !s.isEmpty { return s }
        if let t = title, !t.isEmpty { return t }
        return Fmt.requestTitle(kind)
    }
}

// MARK: - Delegations in words

/// How a chat is named in a decision: `(conversation id, title the server sent) -> "#work"`; see `World.chatName`.
typealias ChatName = (String?, String?) -> String

enum ChatWords {
    /// A chat from the title alone: "#work", or "a chat" when nothing names it.
    static func label(_ title: String?) -> String {
        let name = title?.trimmingCharacters(in: .whitespaces) ?? ""
        return name.isEmpty ? "a chat" : "#\(name)"
    }

    /// "#general, #design +1": the first two chats, then how many more.
    static func list(_ names: [String]) -> String {
        let shown = names.prefix(2).joined(separator: ", ")
        return names.count > 2 ? "\(shown) +\(names.count - 2)" : shown
    }
}

extension Contract.DelegationDraft {
    /// "Always allow files from #work in #general": what a sharing offer asks to be allowed from now on.
    func sharingSentence(chatName: ChatName) -> String {
        let source = chatName(platform?.conversationId, platform?.title)
        let targets = (limits?.recipients ?? []).map { chatName($0, nil) }
        return targets.isEmpty ? "Always allow files from \(source)" : "Always allow files from \(source) in \(ChatWords.list(targets))"
    }
}

extension Contract.DelegationOffer {
    /// The sentence of an offer that is only about sharing between chats (it names what it allows); nil for any other offer.
    func sharingSentence(chatName: ChatName) -> String? {
        guard delegable == true, suggested?.count == 1, let only = suggested?.first, only.category == "sharing" else { return nil }
        return only.sharingSentence(chatName: chatName)
    }
}

extension Rule {
    /// "expires Jan 20" (with the year when it is not this one); nil when the rule has no end or has already ended.
    var expiresText: String? {
        guard let end = expiresAt, end > Date() else { return nil }
        let sameYear = Calendar.current.isDate(end, equalTo: Date(), toGranularity: .year)
        return "expires " + (sameYear ? end.formatted(.dateTime.day().month(.abbreviated)) : end.formatted(.dateTime.day().month(.abbreviated).year()))
    }

    /// "Up to $50 each, $200/month on Stripe": the limits of a delegation, on the platform it covers. For sharing, `platform`
    /// is the source chat's name and the line is "Files from #work → #general".
    func limitsSummary(platform: String, chatName: ChatName = { ChatWords.label($1) }) -> String {
        let l = delegation?.limits
        var parts: [String] = []
        switch delegation?.category {
        case "sharing":
            let targets = (l?.recipients ?? []).map { chatName($0, nil) }
            return targets.isEmpty ? "Files from \(platform)" : "Files from \(platform) → \(ChatWords.list(targets))"
        case "spending":
            if let each = Money.text(l?.perPurchase?.amount, l?.perPurchase?.currency, whole: true) { parts.append("Up to \(each) each") }
            if let month = Money.text(l?.perMonth?.amount, l?.perMonth?.currency, whole: true) { parts.append("\(month)/month") }
            if l?.allowRecurring == true { parts.append("subscriptions OK") }
        case "speaking":
            parts.append(l?.replyOnly == true ? "Replies only" : "Messages")
            if let n = l?.maxPerDay { parts.append("up to \(n)/day") }
        case "committing":
            parts.append(l?.acceptOnly == true ? "Accepts only" : "Accepts and sends invites")
            if let w = l?.window { parts.append(Self.windowText(w)) }
        case "public":
            parts.append("Posts")
            if let n = l?.maxPerDay { parts.append("up to \(n)/day") }
        default: break
        }
        let text = parts.joined(separator: ", ")
        return platform.isEmpty ? text : "\(text) on \(platform)"
    }

    /// "Mon-Fri 9-17".
    private static func windowText(_ w: Contract.DelegationLimits.Window) -> String {
        let names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        let days = (w.days ?? []).filter { (0...7).contains($0) }.sorted()
        let consecutive = days.count >= 3 && zip(days, days.dropFirst()).allSatisfy { $1 == $0 + 1 }
        let dayText = consecutive ? "\(names[days[0]])-\(names[days[days.count - 1]])" : days.map { names[$0] }.joined(separator: ", ")
        func hour(_ s: String?) -> String? {
            guard let s, !s.isEmpty else { return nil }
            let h = s.hasSuffix(":00") ? String(s.dropLast(3)) : s
            return h.hasPrefix("0") && h.count > 1 ? String(h.dropFirst()) : h
        }
        let hours = [hour(w.start), hour(w.end)].compactMap { $0 }.joined(separator: "-")
        return [dayText, hours].filter { !$0.isEmpty }.joined(separator: " ")
    }
}
