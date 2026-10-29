import SwiftUI

// The chat card for a decision beyond the agent's authority: who is asking on which platform, the one-sentence ask,
// what it costs or risks, what you would see, and four answers (Allow once / Allow this kind… / Change it… / Deny).
// Purchases keep the server's order document under the same header.

/// The platform's picture for a brief: connector logo, the site's own icon, Juno's bean, else the category's symbol.
struct PlatformIcon: View {
    @Environment(World.self) private var world
    var brief: Contract.DecisionBrief?
    var size: CGFloat = 36

    var body: some View {
        let platform = brief?.platform
        let symbol = DecisionWords.symbol(brief?.primary)
        switch platform?.kind {
        case "connector": BrandIcon(catalogId: platform?.catalogId, symbol: symbol, size: size)
        case "site": BrandIcon(url: world.absoluteURL(platform?.iconUrl), host: platform?.host ?? platform?.name, symbol: symbol, size: size)
        case "juno": BrandIcon(juno: true, size: size)
        default: BrandIcon(symbol: symbol, size: size)
        }
    }
}

struct DecisionCard: View {
    @Environment(World.self) private var world
    var request: AgentRequest
    var compact: Bool

    @State private var draftText = ""
    @State private var editing = false
    @State private var allTargets = false
    @State private var delegating = false
    @State private var revising = false

    private var name: String { world.agent(request.agentId)?.name ?? "Your agent" }
    private var p: RequestPayload? { request.payload }
    private func decide(_ decision: String, edited: String? = nil) { world.resolve(request.id, decision: decision, editedDraft: edited) }

    var body: some View {
        let brief = p?.brief
        let draft = p?.draft
        VStack(alignment: .leading, spacing: 14) {
            header(brief)
            consequences(brief)
            preview(brief, draft: draft)
            if let why = brief?.why ?? p?.why, !why.isEmpty { ExpandableText(text: why, lines: 3) }
            if let denied = brief?.ifDenied, !denied.isEmpty {
                Text("If you say no: \(denied)").text(.sm).foregroundStyle(Theme.fgSubtle).fixedSize(horizontal: false, vertical: true)
            }
            actions(draft: draft)
        }
        .requestCardSurface()
        .onAppear { draftText = draft?.body ?? "" }
        .sheet(isPresented: $editing) { DraftEditSheet(text: $draftText, title: name) }
        .sheet(isPresented: $delegating) { DelegateSheet(request: request) }
        .sheet(isPresented: $revising) { ReviseSheet(request: request) }
    }

    private func header(_ brief: Contract.DecisionBrief?) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                // An app on the owner's Mac has no icon the phone can load: one app glyph for all of them.
                if p?.macApp != nil { BrandIcon(symbol: "app.dashed") } else { PlatformIcon(brief: brief) }
                VStack(alignment: .leading, spacing: 1) {
                    Text(brief?.platform?.name ?? name).text(.sm, .medium).foregroundStyle(Theme.fg).lineLimit(1)
                    Text("\(name) is asking").text(.xs).foregroundStyle(Theme.fgSubtle).lineLimit(1)
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(request.sentence).text(.md, .semibold).foregroundStyle(Theme.fg).multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                if let notice = p?.notice, !notice.isEmpty {
                    Text(notice).text(.xs).foregroundStyle(Theme.fgSubtle).multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let badges = brief?.badges, !badges.isEmpty {
                HStack(spacing: 6) {
                    ForEach(badges, id: \.self) {
                        CategoryBadge(text: DecisionWords.badge($0), symbol: DecisionWords.symbol($0), warn: $0 == "irreversible" || $0 == "sensitive")
                    }
                }
            }
        }
    }

    @ViewBuilder private func consequences(_ brief: Contract.DecisionBrief?) -> some View {
        let rows = brief?.consequences ?? []
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(rows, id: \.self) { row in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: row.symbol).text(.sm).foregroundStyle(row.declared ? Theme.fgSubtle : Theme.fg).frame(width: 18)
                        Text(row.text).text(.base, .medium).foregroundStyle(row.declared ? Theme.fgMuted : Theme.fg)
                            .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                        if row.declared { Text("agent says").text(.xs).foregroundStyle(Theme.fgSubtle) }
                    }
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.tile, in: .rect(cornerRadius: Radius.tile))
        }
    }

    @ViewBuilder private func preview(_ brief: Contract.DecisionBrief?, draft: Draft?) -> some View {
        if p?.purchase != nil || p?.ui?.isRenderable == true { CheckoutDetails(request: request, compact: compact) }
        if let draft {
            CardTextBlock(subject: draft.subject, text: draftText.isEmpty ? (draft.body ?? "") : draftText) {
                Button { draftText = draftText.isEmpty ? (draft.body ?? "") : draftText; editing = true } label: { CardChip(text: "Edit", symbol: "pencil") }
                    .buttonStyle(.plain)
            }
        } else if brief?.primary == "setup", let target = p?.target, !target.isEmpty {
            CardTile(title: target, mono: true) { Image(systemName: "terminal").text(.base).foregroundStyle(Theme.fgMuted) }
        }
        if let targets = brief?.facts?.targets, !targets.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(targets.prefix(allTargets ? targets.count : 5).enumerated()), id: \.offset) { _, t in
                    CardRow(label: t.label ?? "", value: t.count.map { "×\($0)" } ?? "")
                }
                if targets.count > 5 {
                    Button { withAnimation(.snappy(duration: 0.2)) { allTargets.toggle() } } label: {
                        Text(allTargets ? "Show less" : "Show all \(targets.count)").text(.sm, .medium).foregroundStyle(Theme.fg)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("decision-targets-toggle")
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.tile, in: .rect(cornerRadius: Radius.tile))
        }
    }

    /// An app on the owner's Mac: Allow once / Always allow (kept per app) / Don't allow. Bringing it to the front is one tap, never remembered.
    private func macAppActions(_ macApp: Contract.ApprovalPayload.MacApp) -> some View {
        let foreground = macApp.purpose == "foreground"
        return VStack(spacing: 10) {
            CardButtons(secondary: "Don't allow", primary: foreground ? "Allow" : "Allow once", onSecondary: { decide("denied") },
                        onPrimary: { decide("approved") }, id: "decision")
            if !foreground {
                Button { world.resolve(request.id, decision: "approved", scope: "app") } label: { Text("Always allow").frame(maxWidth: .infinity) }
                    .buttonStyle(WebButton(variant: .secondary, size: .regular))
                    .accessibilityIdentifier("decision-always-app")
            }
        }
    }

    @ViewBuilder private func actions(draft: Draft?) -> some View {
        if let macApp = p?.macApp { macAppActions(macApp) } else { decisionActions(draft: draft) }
    }

    private func decisionActions(draft: Draft?) -> some View {
        // A lone sharing offer says what it allows ("Always allow files from #work in #general…") and gets the full width.
        let sharing = p?.delegationOffer?.sharingSentence(chatName: world.chatName)
        let layout = sharing == nil ? AnyLayout(HStackLayout(spacing: 10)) : AnyLayout(VStackLayout(spacing: 10))
        return VStack(spacing: 10) {
            CardButtons(secondary: "Deny", primary: "Allow once", onSecondary: { decide("denied") },
                        onPrimary: { decide("approved", edited: draftText.isEmpty || draftText == draft?.body ? nil : draftText) }, id: "decision")
            layout {
                if p?.delegationOffer?.delegable == true {
                    Button { delegating = true } label: { Text(sharing.map { "\($0)…" } ?? "Allow this kind…").frame(maxWidth: .infinity) }
                        .buttonStyle(WebButton(variant: .secondary, size: .regular))
                        .accessibilityIdentifier("decision-delegate")
                }
                Button { revising = true } label: { Text("Change it…").frame(maxWidth: .infinity) }
                    .buttonStyle(WebButton(variant: .secondary, size: .regular))
                    .accessibilityIdentifier("decision-revise")
            }
        }
    }
}
