import SwiftUI

// The Permissions tab: what the agent may decide alone (delegations by category), what always asks, what waits on
// you, the history of decisions, then the browsing / reaching-out tiers and any older per-tool rules.

struct ApprovalsTab: View {
    @Environment(World.self) private var world
    var agentId: String

    var body: some View {
        let pending = world.pending(of: agentId)
        VStack(alignment: .leading, spacing: 14) {
            AuthorityTable(agentId: agentId)
            if !pending.isEmpty {
                TabHeader(title: "Waiting on you")
                ForEach(pending) { RequestCard(request: $0, compact: true) }
            }
            DecisionHistory(agentId: agentId)
            TabHeader(title: "Browsing and reaching out")
            TierSettings(agentId: agentId)
            OlderRules(agentId: agentId)
        }
        .task { world.loadDecided(agentId); world.loadGrants(agentId); world.loadDelegations(agentId) }
    }
}

// MARK: - What the agent can decide alone

/// The platform a delegation covers, from its key ("app:gmail", "site:instagram.com", "chat:<conversation id>", "juno").
private struct PlatformRef {
    var catalogId: String?
    var host: String?
    var juno = false
    var name: String

    init(key: String?, apps: [Contract.App]?, chatName: ChatName) {
        let parts = (key ?? "").split(separator: ":", maxSplits: 1).map(String.init)
        switch parts.first {
        case "app":
            catalogId = parts.last
            name = apps?.first { $0.id == parts.last }?.name ?? (parts.last ?? "").replacingOccurrences(of: "-", with: " ").capitalized
        case "site": host = parts.last; name = parts.last ?? ""
        case "chat": name = chatName(parts.count > 1 ? parts[1] : nil, nil)
        case "juno": juno = true; name = "Juno"
        default: name = ""
        }
    }
}

/// One category per row: "Ask me", or its delegations with their limits in words. Tap one to edit or revoke it.
private struct AuthorityTable: View {
    @Environment(World.self) private var world
    var agentId: String
    @State private var editing: Rule?
    @State private var expanded: Set<String> = []

    var body: some View {
        let name = world.agent(agentId)?.name ?? "Your agent"
        let rules = world.delegations(agentId)
        VStack(alignment: .leading, spacing: 14) {
            TabHeader(title: "What \(name) can decide alone")
            VStack(spacing: 0) {
                ForEach(Array(DecisionWords.delegable.enumerated()), id: \.element) { i, category in
                    if i > 0 { Divider().overlay(Theme.border) }
                    block(category, rules: rules.filter { $0.delegation?.category == category })
                }
            }
            .padding(.horizontal, 16)
            .background(Theme.muted, in: .rect(cornerRadius: Radius.xl))
            Text("Always asks you").text(.sm, .semibold).foregroundStyle(Theme.fgMuted)
            VStack(spacing: 0) {
                ForEach(Array(DecisionWords.alwaysAsk.enumerated()), id: \.element) { i, category in
                    if i > 0 { Divider().overlay(Theme.border) }
                    HStack(spacing: 12) {
                        Image(systemName: DecisionWords.symbol(category)).text(.md).foregroundStyle(Theme.fgSubtle).frame(width: 24)
                        Text(DecisionWords.badge(category)).text(.md).foregroundStyle(Theme.fgMuted)
                        Spacer()
                        Text(DecisionWords.alwaysAsksNote(category)).text(.sm).foregroundStyle(Theme.fgSubtle)
                    }
                    .frame(minHeight: 44)
                }
            }
            .padding(.horizontal, 16)
            .background(Theme.muted, in: .rect(cornerRadius: Radius.xl))
        }
        .sheet(item: $editing) { DelegationEditSheet(rule: $0, agentId: agentId) }
    }

    @ViewBuilder private func block(_ category: String, rules: [Rule]) -> some View {
        let shown = expanded.contains(category) ? rules : Array(rules.prefix(3))
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: DecisionWords.symbol(category)).text(.md).foregroundStyle(Theme.fgMuted).frame(width: 24)
                Text(DecisionWords.name(category)).text(.md, .semibold).foregroundStyle(Theme.fg)
                Spacer()
                if rules.isEmpty { Text("Ask me").text(.base).foregroundStyle(Theme.fgMuted) }
            }
            .frame(minHeight: 48)
            ForEach(shown) { rule in
                row(rule)
            }
            if rules.count > 3 {
                Button(expanded.contains(category) ? "Show less" : "Show all \(rules.count)") {
                    if expanded.contains(category) { expanded.remove(category) } else { expanded.insert(category) }
                }
                .text(.sm, .medium).foregroundStyle(Theme.fg).frame(minHeight: 36)
            }
        }
    }

    private func row(_ rule: Rule) -> some View {
        let platform = PlatformRef(key: rule.delegation?.platformKey, apps: world.apps, chatName: world.chatName)
        let expired = rule.expiresAt.map { $0 < Date() } ?? false
        // Sharing between chats always has an end: "Files from #work → #general · expires Jan 20".
        let summary = [rule.limitsSummary(platform: platform.name, chatName: world.chatName), rule.delegation?.category == "sharing" ? rule.expiresText : nil]
            .compactMap { $0 }.joined(separator: " · ")
        return Button { editing = rule } label: {
            HStack(spacing: 12) {
                BrandIcon(catalogId: platform.catalogId, host: platform.host, juno: platform.juno, symbol: DecisionWords.symbol(rule.delegation?.category), size: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text(summary).text(.base, .medium).foregroundStyle(Theme.fg).multilineTextAlignment(.leading)
                    Text(expired ? "Expired" : (rule.useCount ?? 0) > 0 ? "Used \(rule.useCount ?? 0) times · \(Fmt.ago(rule.lastUsedAt))" : "Not used yet")
                        .text(.xs).foregroundStyle(expired ? Theme.warning : Theme.fgSubtle)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right").text(.sm, .semibold).foregroundStyle(Theme.fgSubtle)
            }
            .padding(.vertical, 8)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("delegation-\(rule.id)")
    }
}

/// Edit a delegation's limits, or revoke it.
private struct DelegationEditSheet: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var rule: Rule
    var agentId: String
    @State private var limits = Contract.DelegationLimits()

    var body: some View {
        let platform = PlatformRef(key: rule.delegation?.platformKey, apps: world.apps, chatName: world.chatName)
        let category = rule.delegation?.category
        JunoSheet(icon: DecisionWords.symbol(category), title: DecisionWords.name(category),
                  guidance: rule.limitsSummary(platform: platform.name, chatName: world.chatName), primary: "Save",
                  primaryEnabled: DelegationLimitFields.isValid(category, limits) && limits != rule.delegation?.limits, long: true, id: "delegation",
                  onPrimary: { world.updateDelegation(rule, limits: limits, agentId: agentId); dismiss() },
                  onCancel: { dismiss() }) {
            DelegationLimitFields(category: category, limits: $limits)
            Button { world.revokeDelegation(rule, agentId: agentId); dismiss() } label: { Text("Revoke").frame(maxWidth: .infinity) }
                .buttonStyle(WebButton(variant: .secondary, size: .large))
                .accessibilityIdentifier("revoke-delegation")
        }
        .onAppear { limits = rule.delegation?.limits ?? Contract.DelegationLimits() }
    }
}

// MARK: - History

private struct DecisionHistory: View {
    @Environment(World.self) private var world
    var agentId: String
    @State private var limit = 8
    @State private var category: String?
    @State private var outcome: String?
    @State private var autoOpen = false
    @State private var autoLimit = 5

    var body: some View {
        let all = world.history(agentId)
        let filtered = all.filter {
            (category == nil || $0.payload?.brief?.categories?.contains(category ?? "") == true) && (outcome == nil || $0.outcome == outcome)
        }
        // Allowed by a rule is noise: one group row, unless that is the very outcome being looked at.
        let auto = outcome == nil ? filtered.filter { $0.outcome == "allowed_rule" } : []
        let rest = outcome == nil ? filtered.filter { $0.outcome != "allowed_rule" } : filtered
        let more = rest.count > limit || world.decided[agentId]?.next != nil
        VStack(alignment: .leading, spacing: 14) {
            TabHeader(title: "History")
            filters(all)
            if all.isEmpty { EmptyLine(text: "No decisions yet.") }
            else if filtered.isEmpty { EmptyLine(text: "Nothing matches.") }
            if !auto.isEmpty { autoGroup(auto) }
            ForEach(rest.prefix(limit)) { HistoryRow(request: $0) }
            if more {
                Button("Show more") {
                    limit += 8
                    if rest.count < limit { world.loadDecided(agentId, more: true) }
                }
                .buttonStyle(WebButton(variant: .secondary)).frame(maxWidth: .infinity)
            }
        }
    }

    /// Menus for the kinds and outcomes that appear in what is loaded.
    @ViewBuilder private func filters(_ all: [AgentRequest]) -> some View {
        let categories = DecisionWords.delegable + DecisionWords.alwaysAsk
        let kinds = categories.filter { c in all.contains { $0.payload?.brief?.categories?.contains(c) == true } }
        let outcomes = ["allowed_once", "allowed_rule", "denied", "revised", "timed_out", "cancelled", "handed_back"].filter { o in all.contains { $0.outcome == o } }
        if kinds.count > 1 || outcomes.count > 1 {
            HStack(spacing: 8) {
                if kinds.count > 1 { FilterMenu(title: "Kind", options: kinds.map { ($0, DecisionWords.badge($0)) }, selection: $category) }
                if outcomes.count > 1 { FilterMenu(title: "Result", options: outcomes.map { ($0, DecisionWords.outcome($0) ?? $0) }, selection: $outcome) }
                Spacer(minLength: 0)
            }
        }
    }

    private func autoGroup(_ rows: [AgentRequest]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { withAnimation(.snappy(duration: 0.2)) { autoOpen.toggle() } } label: {
                HStack(spacing: 12) {
                    Image(systemName: "checkmark.shield").text(.base, .semibold).foregroundStyle(Theme.fgMuted).frame(width: 28, height: 28)
                    Text("\(rows.count) allowed by your rules").text(.base, .semibold).foregroundStyle(Theme.fg)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right").text(.sm, .semibold).foregroundStyle(Theme.fgSubtle).rotationEffect(.degrees(autoOpen ? 90 : 0))
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("history-auto-group")
            if autoOpen {
                ForEach(rows.prefix(autoLimit)) { HistoryRow(request: $0) }
                ShowMore(shown: min(autoLimit, rows.count), total: rows.count) { autoLimit += 5 }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.muted, in: .rect(cornerRadius: 22))
    }
}

private struct FilterMenu: View {
    var title: String
    var options: [(String, String)]
    @Binding var selection: String?

    var body: some View {
        Menu {
            Picker(title, selection: $selection) {
                Text("All").tag(String?.none)
                ForEach(options, id: \.0) { Text($0.1).tag(String?.some($0.0)) }
            }
        } label: {
            HStack(spacing: 4) {
                Text(options.first { $0.0 == selection }?.1 ?? title)
                Image(systemName: "chevron.up.chevron.down").text(.xxs, .semibold)
            }
            .text(.sm, .medium).foregroundStyle(selection == nil ? Theme.fgMuted : Theme.fg)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(Theme.muted, in: .capsule)
        }
        .accessibilityIdentifier("history-filter-\(title.lowercased())")
    }
}

/// A decided request: platform icon, the sentence, its key consequence, the outcome and when, with the kind as a badge.
/// A request without a brief (from before decision briefs) keeps the older row. Tapping opens the details.
private struct HistoryRow: View {
    var request: AgentRequest
    @State private var open = false

    var body: some View {
        if let brief = request.payload?.brief {
            VStack(alignment: .leading, spacing: 0) {
                Button { withAnimation(.snappy(duration: 0.2)) { open.toggle() } } label: {
                    HStack(alignment: .top, spacing: 12) {
                        PlatformIcon(brief: brief, size: 32)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(request.sentence).text(.base, .semibold).foregroundStyle(Theme.fg).lineLimit(open ? nil : 2).multilineTextAlignment(.leading)
                            if let key = brief.keyConsequence { Text(key).text(.sm).foregroundStyle(Theme.fgMuted).lineLimit(1) }
                            Text([DecisionWords.outcome(request.outcome) ?? ResolvedRequestRow.label(request).title, request.resolvedAt.map { Fmt.ago($0) }]
                                .compactMap { $0 }.joined(separator: " · "))
                                .text(.xs).foregroundStyle(Theme.fgSubtle)
                        }
                        Spacer(minLength: 0)
                        if let primary = brief.badges.first {
                            CategoryBadge(text: DecisionWords.badge(primary), warn: primary == "irreversible" || primary == "sensitive")
                        }
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                if open { RequestFacts(request: request).padding(.top, 12) }
            }
            .decidedRowSurface()
        } else {
            ResolvedRequestRow(request: request)
        }
    }
}

// MARK: - Tiers and older rules

/// The computer the agent works on, browsing and reaching out as native pickers. (Purchases and sending are decided per request now, not by a tier.)
private struct TierSettings: View {
    @Environment(World.self) private var world
    var agentId: String

    var body: some View {
        let tiers = world.agent(agentId)?.permissionTiers
        VStack(spacing: 0) {
            computerRow
            Divider().overlay(Theme.border)
            row("Browsing", selection: (tiers?.browsing ?? "normal") == "strict" ? "strict" : "normal", options: [("strict", "Strict"), ("normal", "Normal")]) { v in world.setTier(agentId) { $0.browsing = v } }
            Divider().overlay(Theme.border)
            row("Reaching out", selection: (tiers?.reachOut ?? "normal") == "off" ? "off" : "on", options: [("on", "On"), ("off", "Off")]) { v in
                world.setTier(agentId) { $0.reachOut = v == "off" ? "off" : (tiers?.reachOut == "off" || tiers?.reachOut == nil ? "normal" : tiers?.reachOut) }
            }
        }
        .padding(.horizontal, 16)
        .background(Theme.muted, in: .rect(cornerRadius: Radius.xl))
    }

    /// "Can use your Mac": a switch, available once a Mac is paired; an agent already allowed keeps showing it, with the Mac's state.
    @ViewBuilder private var computerRow: some View {
        let on = world.canUseMac(agentId)
        let mac = world.myMac
        let paired = mac?.paired == true
        VStack(alignment: .leading, spacing: 4) {
            Toggle("Can use your Mac", isOn: Binding(get: { on }, set: { world.setMacAccess(agentId, $0) }))
                .text(.md).foregroundStyle(Theme.fg).tint(Theme.fg)
                .disabled(!paired && !on)
                .accessibilityIdentifier("tier-Computer")
                .frame(minHeight: 48)
            Text("Files and commands on your Mac always ask first, except inside ~/Juno.")
                .text(.sm).foregroundStyle(Theme.fgMuted).frame(maxWidth: .infinity, alignment: .leading)
            if !paired && !on {
                Text("Connect your Mac in Settings first.")
                    .text(.sm).foregroundStyle(Theme.fgMuted).frame(maxWidth: .infinity, alignment: .leading)
            }
            if on && !(paired && mac?.online == true) {
                Text("Your Mac is offline. Open Juno on it so this agent can use it again.")
                    .text(.sm).foregroundStyle(Theme.warning).frame(maxWidth: .infinity, alignment: .leading)
            }
            if paired { MacStopLine() }
        }
        .padding(.bottom, 10)
        .task { await world.refreshMyMac() }
    }

    private func row(_ title: String, selection: String, options: [(String, String)], set: @escaping (String) -> Void) -> some View {
        HStack {
            Text(title).text(.md).foregroundStyle(Theme.fg)
            Spacer()
            Picker(title, selection: Binding(get: { selection }, set: set)) {
                ForEach(options, id: \.0) { Text($0.1).tag($0.0) }
            }
            .pickerStyle(.menu).labelsHidden().tint(Theme.fgMuted)
            .accessibilityIdentifier("tier-\(title)")
        }
        .frame(minHeight: 48)
    }
}

/// Per-tool "allowed without asking" rules from before delegations: read-only, revocable, none can be added.
private struct OlderRules: View {
    @Environment(World.self) private var world
    var agentId: String
    @State private var open = false
    @State private var limit = 5

    var body: some View {
        let grants = world.standingGrants(agentId)
        if !grants.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Button { withAnimation(.snappy(duration: 0.2)) { open.toggle() } } label: {
                    HStack {
                        Text("Older rules (\(grants.count))").text(.md, .semibold).foregroundStyle(Theme.fg)
                        Spacer()
                        Image(systemName: "chevron.right").text(.sm, .semibold).foregroundStyle(Theme.fgSubtle).rotationEffect(.degrees(open ? 90 : 0))
                    }
                    .padding(.top, 4)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("older-rules")
                if open {
                    ForEach(grants.prefix(limit)) { rule in
                        HStack(alignment: .center, spacing: 12) {
                            Image(systemName: "checkmark.shield").text(.md).foregroundStyle(Theme.fgMuted)
                                .frame(width: 36, height: 36).background(Theme.muted, in: .rect(cornerRadius: Radius.lg))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(rule.description ?? "Allowed without asking").text(.md, .semibold).foregroundStyle(Theme.fg).multilineTextAlignment(.leading)
                                if let at = rule.createdAt { Text("Allowed \(Fmt.ago(at))").text(.sm).foregroundStyle(Theme.fgSubtle) }
                            }
                            Spacer(minLength: 8)
                            Button("Revoke") { world.revoke(rule, agentId: agentId) }
                                .buttonStyle(WebButton(variant: .secondary, size: .sm))
                                .accessibilityIdentifier("revoke-grant")
                        }
                    }
                    ShowMore(shown: min(limit, grants.count), total: grants.count) { limit += 5 }
                }
            }
        }
    }
}
