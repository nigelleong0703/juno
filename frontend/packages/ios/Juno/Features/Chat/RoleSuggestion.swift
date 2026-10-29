import SwiftUI

/// The agent's role suggestion as a card in its chat (BACKEND §10.11, item `role_suggestion`), styled like the
/// request cards: pending while the agent still holds this suggestion, otherwise the outcome. The name is
/// editable before "Use this role"; "Not now" tells the server, which then stops suggesting.
struct RoleSuggestionCard: View {
    @Environment(World.self) private var world
    var item: Item
    @State private var name: String

    /// The name starts as the suggestion. Set here, not in onAppear: a state write on appear inside the lazy
    /// transcript kept re-laying it out under accessibility (UI tests never saw the app go idle).
    init(item: Item) {
        self.item = item
        _name = State(initialValue: item.title ?? "")
    }

    var body: some View {
        let agent = world.agent(item.agentId)
        HStack(alignment: .top, spacing: 6) {
            AvatarView(agent: agent, size: AvatarSize.sm).padding(.top, 2)
            VStack(alignment: .leading, spacing: 0) {
                Text("\(agent?.name ?? "Your agent") looks like your…").text(.sm).foregroundStyle(Theme.fgMuted)
                if pending(agent) {
                    TextField("Role", text: $name)
                        .text(.lg, .semibold)
                        .padding(.horizontal, 10).frame(height: 36)
                        .background(Theme.inputBg, in: .rect(cornerRadius: Radius.md))
                        .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(Theme.border))
                        .padding(.top, 6)
                        .submitLabel(.done)
                } else {
                    Text(item.title ?? "").text(.lg, .semibold).padding(.top, 2)
                }
                if let d = item.description, !d.isEmpty { Text(d).text(.sm).foregroundStyle(Theme.fgMuted).padding(.top, 4) }
                Group {
                    if pending(agent) {
                        HStack(spacing: 6) {
                            Button("Use this role") { if let id = agent?.id { world.acceptRole(id, title: name) } }
                                .buttonStyle(WebButton(variant: .primary))
                            Button("Not now") { if let id = agent?.id { world.dismissRole(id) } }
                                .buttonStyle(WebButton(variant: .ghost))
                        }
                    } else {
                        outcome(agent)
                    }
                }
                .padding(.top, 10)
            }
            .foregroundStyle(Theme.bubbleAgentFg)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.bubbleAgent, in: .rect(cornerRadius: Radius.xxl))
        }
        .containerRelativeFrame(.horizontal, alignment: .leading) { w, _ in min(w * 0.8, 560) }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Pending while the agent still holds this very suggestion.
    private func pending(_ agent: Agent?) -> Bool {
        RoleSuggestionRule.isPending(agent: agent, suggestionAt: item.suggestionAt)
    }

    @ViewBuilder private func outcome(_ agent: Agent?) -> some View {
        // Same rule as the web (RoleSuggestionItem.tsx): dismissed after this suggestion, or still no real role.
        let dismissed = RoleSuggestionRule.isDismissed(agent: agent, suggestionAt: item.suggestionAt)
        HStack(spacing: 6) {
            Circle().fill(dismissed ? Theme.fgSubtle : Theme.success).frame(width: 6, height: 6)
            Text(dismissed ? "Not now" : "Role set: \(agent?.title ?? item.title ?? "")")
        }
        .text(.xs).foregroundStyle(Theme.fgMuted)
    }
}

enum RoleSuggestionRule {
    /// Pending while the agent still holds this very suggestion.
    static func isPending(agent: Agent?, suggestionAt: Date?) -> Bool {
        guard let at = agent?.roleSuggestion?.createdAt, let mine = suggestionAt else { return false }
        return abs(at.timeIntervalSince(mine)) < 1
    }

    /// Resolved as "Not now": dismissed after this suggestion, or still no real role.
    static func isDismissed(agent: Agent?, suggestionAt: Date?) -> Bool {
        let role = (agent?.title ?? "").trimmingCharacters(in: .whitespaces)
        return (agent?.roleSuggestionDismissedAt.map { $0 >= (suggestionAt ?? .distantPast) } ?? false)
            || ["", "Agent", "New agent"].contains(role)
    }
}
