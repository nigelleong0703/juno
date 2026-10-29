import SwiftUI

// Swipe to reply, quote cards, the reply chip, date separators and the jump-to-bottom button.
// Patterns adapted from exyte/Chat (MIT, https://github.com/exyte/Chat): SwipeActions, DateSeparatorView and
// the ChatView "list with button". WhatsApp / iMessage behaviour as the reference.

// MARK: - Swipe to reply

/// Drag a message to the right: the reply arrow fades in behind it, a tick at the threshold, release to reply.
struct SwipeToReply: ViewModifier {
    var onReply: () -> Void
    private let threshold: CGFloat = 60
    @State private var dx: CGFloat = 0
    @State private var crossed = false

    func body(content: Content) -> some View {
        ZStack(alignment: .leading) {
            Image(systemName: "arrow.turn.up.left")
                .font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.fgMuted)
                .frame(width: 32, height: 32).background(Theme.muted, in: .circle)
                .scaleEffect(0.6 + 0.4 * progress).opacity(progress)
            content.offset(x: dx)
        }
        .gesture(HorizontalPan { w in
            dx = w < threshold ? w : threshold + (w - threshold) * 0.25
            if w >= threshold, !crossed { crossed = true; UIImpactFeedbackGenerator(style: .light).impactOccurred() }
            if w < threshold { crossed = false }
        } onEnd: {
            if crossed { onReply() }
            crossed = false
            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) { dx = 0 }
        })
    }

    private var progress: CGFloat { min(dx / threshold, 1) }
}

extension View {
    func swipeToReply(perform: @escaping () -> Void) -> some View { modifier(SwipeToReply(onReply: perform)) }
}

// MARK: - Quotes ("> line" prefix, since the backend has no reply field)

enum Quote {
    /// Splits a leading block of "> " lines off the message.
    static func split(_ s: String) -> (quote: String?, body: String) {
        var quoted: [String] = []
        var rest = s.split(separator: "\n", omittingEmptySubsequences: false)[...]
        while let line = rest.first, line.hasPrefix(">") {
            quoted.append(String(line.dropFirst().drop(while: { $0 == " " })))
            rest = rest.dropFirst()
        }
        guard !quoted.isEmpty else { return (nil, s) }
        let body = rest.drop(while: { $0.trimmingCharacters(in: .whitespaces).isEmpty }).joined(separator: "\n")
        return (quoted.joined(separator: "\n"), body)
    }

    /// "> first ~140 characters\n\n" for the message being replied to.
    static func prefix(for item: Item) -> String {
        let source = Quote.split(item.text ?? item.markdown ?? "").body
        let cut = source.count > 140 ? String(source.prefix(140)) + "…" : source
        return cut.split(separator: "\n", omittingEmptySubsequences: false).map { "> \($0)" }.joined(separator: "\n") + "\n\n"
    }
}

/// The quoted text inside a bubble: accent bar on the left, muted text, two lines.
struct QuoteCard: View {
    var text: String
    var ink: Color
    var body: some View {
        HStack(spacing: 8) {
            Capsule().fill(ink.opacity(0.55)).frame(width: 3)
            Text(text).text(.sm).foregroundStyle(ink.opacity(0.75)).lineLimit(2)
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 8).padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ink.opacity(0.1), in: .rect(cornerRadius: Radius.md))
    }
}

/// Above the composer field: who and what you are replying to, × to cancel.
struct ReplyChip: View {
    @Environment(World.self) private var world
    var conversationId: String
    var item: Item

    var body: some View {
        let isUser = item.type == "user_message"
        // A platform stranger's authorId is a synthetic id, not a member: their name is the channel sender's.
        let stranger = item.channelSender?.role == "stranger"
        let name = isUser
            ? (stranger ? (item.channelSender?.name.flatMap { $0.isEmpty ? nil : $0 } ?? "Someone") : item.authorId == world.selfId ? "You" : world.member(item.authorId)?.name ?? "Teammate")
            : (world.agent(item.agentId)?.name ?? "Agent")
        let text = Quote.split(item.text ?? item.markdown ?? "").body
        HStack(spacing: 8) {
            Capsule().fill(Theme.fgSubtle).frame(width: 3)
            VStack(alignment: .leading, spacing: 0) {
                Text(name).text(.xs, .medium).foregroundStyle(Theme.fg)
                Text(text).text(.xs).foregroundStyle(Theme.fgMuted).lineLimit(1)
            }
            Spacer(minLength: 4)
            Button { world.replyTo[conversationId] = nil } label: {
                Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.fgMuted)
                    .frame(width: 28, height: 28).contentShape(.rect)
            }
            .accessibilityLabel("Cancel reply")
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.leading, 12).padding(.trailing, 4).padding(.vertical, 6)
        .glassEffect(.regular, in: .rect(cornerRadius: 16))
    }
}

extension World {
    /// The quote prefix for the reply in progress (and ends the reply); "" when none.
    func takeReplyQuote(in conversationId: String) -> String {
        guard let item = replyTo.removeValue(forKey: conversationId) else { return "" }
        return Quote.prefix(for: item)
    }
}

// MARK: - Date separators

struct DateSeparator: View {
    var date: Date
    var body: some View {
        Text(Self.label(date)).text(.xs, .medium).foregroundStyle(Theme.fgMuted)
            .padding(.horizontal, 10).padding(.vertical, 3)
            .background(Theme.muted, in: .capsule)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
    }

    static func label(_ date: Date) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(date) { return "Today" }
        if cal.isDateInYesterday(date) { return "Yesterday" }
        let days = cal.dateComponents([.day], from: cal.startOfDay(for: date), to: cal.startOfDay(for: Date())).day ?? 99
        if days > 0 && days < 7 { return date.formatted(.dateTime.weekday(.wide)) }
        let sameYear = cal.isDate(date, equalTo: Date(), toGranularity: .year)
        return sameYear ? date.formatted(.dateTime.day().month(.abbreviated)) : date.formatted(.dateTime.day().month(.abbreviated).year())
    }

    /// The items that open a new day (the first dated item included), with their dates.
    static func dayStarts(_ items: [Item]) -> [String: Date] {
        var result: [String: Date] = [:]
        var last: Date?
        for item in items {
            guard let at = item.at else { continue }
            if let l = last, Calendar.current.isDate(at, inSameDayAs: l) {} else { result[item.id] = at }
            last = at
        }
        return result
    }
}
