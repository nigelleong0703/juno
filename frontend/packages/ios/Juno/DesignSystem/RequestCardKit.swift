import SwiftUI
import UIKit

// The request card kit (docs mockups "pass 2"): one white card per thing the agent needs from the user, with the
// type and the agent in the header, a muted guidance line, tiles / a preview / a draft, and two equal buttons.
// Pure layout: no app state, the callers pass strings, images and actions.

/// The header both the request cards and the sheets (`JunoSheet`) open with: icon tile, semibold title, muted guidance.
struct CardHeader: View {
    var icon: String
    var title: String
    var guidance: String?
    /// One short muted line under the title (an approval's `notice`); nothing when absent.
    var notice: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: icon).text(.xl).foregroundStyle(Theme.fg).frame(width: 28, height: 28)
                    Text(title).text(.md, .semibold).foregroundStyle(Theme.fg).multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let notice, !notice.isEmpty {
                    Text(notice).text(.xs).foregroundStyle(Theme.fgSubtle).multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.leading, 40)
                }
            }
            if let guidance, !guidance.isEmpty {
                Text(guidance).text(.sm).foregroundStyle(Theme.fgMuted).multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Context text under a card's title: all of it up to `lines` lines, past that the first lines and a "Show more" that
/// opens the rest. Which of the two shows is decided by layout (`ViewThatFits`), not after it, so a row measured
/// before it appears already has its final height.
struct ExpandableText: View {
    var text: String
    var lines = 6
    @State private var expanded = false

    var body: some View {
        let limit = TextSize.sm.lineHeight * CGFloat(lines)
        let body = Text((try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text))
        Group {
            if expanded {
                VStack(alignment: .leading, spacing: 0) { body; toggle("Show less") }
            } else {
                ViewThatFits(in: .vertical) {
                    body.fixedSize(horizontal: false, vertical: true)
                    // The line the button takes is one of the `lines`, so this variant is as tall as the limit.
                    VStack(alignment: .leading, spacing: 0) { body.lineLimit(lines - 1); toggle("Show more") }
                }
                .frame(maxHeight: limit + 2, alignment: .top)
            }
        }
        .text(.sm).foregroundStyle(Theme.fgMuted).multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func toggle(_ title: String) -> some View {
        Button { withAnimation(.snappy(duration: 0.2)) { expanded.toggle() } } label: {
            Text(title).text(.sm, .medium).foregroundStyle(Theme.fg)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("context-toggle")
    }
}

/// Card surface: radius 28, hairline, padding 22 / 16 / 16. Header = icon + semibold "<Type> · <Agent> wants to …".
struct RequestCardShell<Content: View, Actions: View>: View {
    var icon: String
    var title: String
    var guidance: String?
    var notice: String? = nil
    @ViewBuilder var content: Content
    @ViewBuilder var actions: Actions

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            CardHeader(icon: icon, title: title, guidance: guidance, notice: notice)
            content
            actions
        }
        .requestCardSurface()
    }
}

extension View {
    /// The request card's surface: radius 28, hairline, padding 22 / 16 / 16.
    func requestCardSurface() -> some View {
        padding(.top, 22).padding(.horizontal, 16).padding(.bottom, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.requestCard, in: .rect(cornerRadius: Radius.card))
            .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.border, lineWidth: 0.5))
    }
}

extension View {
    /// A decided request's row surface: radius 22, hairline, padding 16 / 12.
    func decidedRowSurface() -> some View {
        padding(.horizontal, 16).padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.requestCard, in: .rect(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(Theme.border, lineWidth: 0.5))
    }
}

/// A small text label for a decision's kind ("Spending", "Can't be undone"); `warn` tints it for the kinds to be careful with.
struct CategoryBadge: View {
    var text: String
    var symbol: String?
    var warn = false
    var body: some View {
        HStack(spacing: 4) {
            if let symbol { Image(systemName: symbol).text(.xxs, .semibold) }
            Text(text).text(.xs, .medium).lineLimit(1)
        }
        .foregroundStyle(warn ? Theme.warning : Theme.fgMuted)
        .padding(.horizontal, 8).padding(.vertical, 3)
        .background(warn ? Theme.warning.opacity(0.14) : Theme.muted, in: .capsule)
    }
}

extension RequestCardShell where Content == EmptyView {
    init(icon: String, title: String, guidance: String? = nil, @ViewBuilder actions: () -> Actions) {
        self.init(icon: icon, title: title, guidance: guidance, content: { EmptyView() }, actions: actions)
    }
}

/// A rounded tile (radius 20): leading picture, title, subtitle, optional chevron.
struct CardTile<Leading: View>: View {
    var title: String
    var subtitle: String?
    var mono = false
    var chevron = false
    @ViewBuilder var leading: Leading

    var body: some View {
        HStack(spacing: 12) {
            leading
            VStack(alignment: .leading, spacing: 2) {
                if mono {
                    Text(title).font(.system(.callout, design: .monospaced)).foregroundStyle(Theme.fg).multilineTextAlignment(.leading)
                } else {
                    Text(title).text(.lg).foregroundStyle(Theme.fg).multilineTextAlignment(.leading)
                }
                if let subtitle { Text(subtitle).text(.sm).foregroundStyle(Theme.fgSubtle).multilineTextAlignment(.leading) }
            }
            Spacer(minLength: 0)
            if chevron { Image(systemName: "chevron.right").text(.sm, .semibold).foregroundStyle(Theme.fgSubtle) }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.tile, in: .rect(cornerRadius: Radius.tile))
    }
}

/// The round badge on a tile's left: an SF Symbol on the card colour, or initials.
struct TileBadge: View {
    var symbol: String?
    var initials: String?
    var body: some View {
        Group {
            if let symbol { Image(systemName: symbol).text(.base).foregroundStyle(Theme.fgMuted) }
            else { Text(initials ?? "").text(.sm, .semibold).foregroundStyle(Theme.fg) }
        }
        .frame(width: 40, height: 40)
        .background(Theme.requestCard, in: .circle)
    }
}

/// A pill floating over a picture: "Review order ↗", "● Live", "● You".
struct CardChip: View {
    var text: String
    var symbol: String?
    var live: Color?
    var body: some View {
        HStack(spacing: 6) {
            if let live { Circle().fill(live).frame(width: 7, height: 7) }
            Text(text).text(.sm, .medium)
            if let symbol { Image(systemName: symbol).text(.xs, .semibold) }
        }
        .foregroundStyle(Theme.fg)
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(Theme.card, in: .capsule)
        .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
    }
}

/// A screenshot (purchase page, the agent's screen) in a rounded frame, with a chip in its corner.
struct CardPreview<Chip: View>: View {
    var image: UIImage?
    @ViewBuilder var chip: Chip

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            // Fixed height either way: the image arrives after the card is on screen, and the row must not grow then.
            if let image {
                Color.clear.frame(maxWidth: .infinity).frame(height: 180)
                    .overlay(alignment: .top) { Image(uiImage: image).resizable().scaledToFill() }
                    .clipped()
            } else {
                Rectangle().fill(Theme.tile).frame(maxWidth: .infinity).frame(height: 180)
                    .overlay { Image(systemName: "photo").text(.xl).foregroundStyle(Theme.fgSubtle) }
            }
            chip.padding(10)
        }
        .background(Theme.tile)
        .clipShape(.rect(cornerRadius: Radius.preview))
        .overlay(RoundedRectangle(cornerRadius: Radius.preview).strokeBorder(Theme.border, lineWidth: 0.5))
    }
}

/// A subject line and body in a bordered box, with an "Edit" chip in its corner (the draft under Send).
struct CardTextBlock<Edit: View>: View {
    var subject: String?
    var text: String
    @ViewBuilder var edit: Edit

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let subject, !subject.isEmpty { Text(subject).text(.base, .semibold).foregroundStyle(Theme.fg) }
            Text(text).text(.base).foregroundStyle(Theme.fg).fixedSize(horizontal: false, vertical: true)
            HStack { Spacer(); edit }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.requestCard, in: .rect(cornerRadius: Radius.tile))
        .overlay(RoundedRectangle(cornerRadius: Radius.tile).strokeBorder(Theme.border, lineWidth: 0.5))
    }
}

/// "Estimated total   S$2,399".
struct CardRow: View {
    var label: String
    var value: String
    var body: some View {
        HStack { Text(label).text(.base).foregroundStyle(Theme.fg); Spacer(); Text(value).text(.base, .medium).foregroundStyle(Theme.fg) }
            .padding(.horizontal, 2)
    }
}

/// Two equal buttons: a grey secondary on the left, the primary (black / white) on the right.
struct CardButtons: View {
    var secondary: String
    var primary: String
    var primaryEnabled = true
    var onSecondary: () -> Void
    var onPrimary: () -> Void
    var id = "card"

    var body: some View {
        HStack(spacing: 10) {
            Button(action: onSecondary) { Text(secondary).frame(maxWidth: .infinity) }
                .buttonStyle(WebButton(variant: .secondary, size: .large))
                .accessibilityIdentifier("\(id)-secondary")
            Button(action: onPrimary) { Text(primary).frame(maxWidth: .infinity) }
                .buttonStyle(WebButton(variant: .primary, size: .large))
                .disabled(!primaryEnabled)
                .accessibilityIdentifier("\(id)-primary")
        }
    }
}

/// One full-width primary button ("Submit", "Return control").
struct CardPrimaryButton: View {
    var title: String
    var enabled = true
    var loading = false
    var id = "card-primary"
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if loading { ProgressView().controlSize(.small).tint(Theme.primaryFg) }
                Text(title)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(WebButton(variant: .primary, size: .large)).disabled(!enabled || loading).accessibilityIdentifier(id)
    }
}

/// A small pill action on a card ("Edit", "Something else…") or a choice chip: selected = outlined + check.
struct CardChoiceChip: View {
    var title: String
    var note: String?
    var selected: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if selected { Image(systemName: "checkmark").text(.xs, .semibold) }
                Text(title).text(.base, selected ? .semibold : .regular)
                if let note { Text(note).text(.xs).foregroundStyle(Theme.fgSubtle) }
            }
            .foregroundStyle(Theme.fg)
            .padding(.horizontal, 14).padding(.vertical, 9)
            .background(selected ? Color.clear : Theme.tile, in: .capsule)
            .overlay(Capsule().strokeBorder(selected ? Theme.fg : .clear, lineWidth: 1.5))
        }
        .buttonStyle(.plain)
    }
}

/// Chips wrapped onto as many rows as they need.
struct CardFlow: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(proposal.width ?? 0, subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let laid = arrange(bounds.width, subviews)
        for (view, origin) in zip(subviews, laid.origins) { view.place(at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y), proposal: .unspecified) }
    }

    private func arrange(_ width: CGFloat, _ subviews: Subviews) -> (size: CGSize, origins: [CGPoint]) {
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0, widest: CGFloat = 0
        var origins: [CGPoint] = []
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width { x = 0; y += row + spacing; row = 0 }
            origins.append(CGPoint(x: x, y: y))
            x += size.width + spacing; row = max(row, size.height); widest = max(widest, x - spacing)
        }
        return (CGSize(width: widest, height: y + row), origins)
    }
}

/// A decided request as one slim row (check / cross, "Sent · Email to Mei Lin", chevron); tapping expands it in place.
enum CardOutcome { case done, refused, neutral }

struct ResolvedCardRow<Detail: View>: View {
    var outcome: CardOutcome
    var title: String
    var subtitle: String?
    @ViewBuilder var detail: Detail
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(.snappy(duration: 0.2)) { open.toggle() } } label: {
                HStack(spacing: 12) {
                    Image(systemName: symbol).text(.base, .bold).foregroundStyle(.white)
                        .frame(width: 28, height: 28).background(tint, in: .circle)
                    (Text(title).font(.body.weight(.semibold)) + Text(subtitle.map { " · \($0)" } ?? "").foregroundStyle(Theme.fgMuted))
                        .text(.base).foregroundStyle(Theme.fg).lineLimit(open ? nil : 1).multilineTextAlignment(.leading)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right").text(.sm, .semibold).foregroundStyle(Theme.fgSubtle).rotationEffect(.degrees(open ? 90 : 0))
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            if open { detail.padding(.top, 12) }
        }
        .decidedRowSurface()
    }

    private var symbol: String { outcome == .done ? "checkmark" : outcome == .refused ? "xmark" : "minus" }
    private var tint: Color { outcome == .done ? Theme.success : outcome == .refused ? Theme.danger : Theme.fgSubtle }
}

/// The round black Stop button on a running row (Muse).
struct RoundStopButton: View {
    var action: () -> Void
    var body: some View {
        Button(action: action) {
            RoundedRectangle(cornerRadius: 3).fill(Theme.primaryFg).frame(width: 12, height: 12)
                .frame(width: 36, height: 36).background(Theme.primary, in: .circle)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Stop")
    }
}
