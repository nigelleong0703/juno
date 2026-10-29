import SwiftUI

/// Discover, the fourth tab (owner-approved 2026-10-26, first version, our own content): a featured agent, the categories,
/// and what can be installed. Install creates an agent from a template through the normal create flow and opens its chat;
/// skills open on the Skills page. The footer says what is shared: persona, skills and workflows only.
struct DiscoverTab: View {
    @Environment(World.self) private var world
    @State private var category = Category.all
    @State private var installing = false
    /// The skill "Add" was tapped on; the agent it goes to is asked for next.
    @State private var pickingFor: Skill?
    /// A failed Install or Add, shown in the tab until the next attempt (the same quiet note the Team tab uses).
    @State private var note: String?
    /// Filters the templates and the skills by name and description.
    @State private var query = ""

    enum Category: String, CaseIterable, Identifiable {
        case all = "All", agents = "Agents", skills = "Skills"
        var id: String { rawValue }
    }

    /// The agent templates, the same six as the web's new-agent dialog (name, role and one line on what it does).
    static let templates: [DiscoverTemplate] = [
        DiscoverTemplate(name: "Juno", title: "Research & inbox", blurb: "Reads your inbox, researches answers and drafts replies."),
        DiscoverTemplate(name: "Patch", title: "Engineering & PRs", blurb: "Watches repositories, reviews pull requests and triages issues."),
        DiscoverTemplate(name: "Ledger", title: "Finance & expenses", blurb: "Reconciles spend, files reimbursements and flags anomalies."),
        DiscoverTemplate(name: "Echo", title: "Meetings & notes", blurb: "Joins calls, writes summaries and tracks follow-ups."),
        DiscoverTemplate(name: "Scout", title: "Recruiting & network", blurb: "Screens candidates and keeps your network warm."),
        DiscoverTemplate(name: "Atlas", title: "Travel & calendar", blurb: "Plans trips, books travel and protects focus time."),
    ]

    private static let limit = 6

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                TabHeading(title: "Discover")
                if let note {
                    Text(note).text(.sm).foregroundStyle(Theme.danger)
                }
                TeamSearchField(text: $query, prompt: "Search agents and skills")
                // The featured card is the first template: it is not listed again under it.
                let featured = category == .all && query.isEmpty ? Self.templates.first : nil
                if let featured {
                    featuredCard(featured)
                }
                Picker("Discover categories", selection: $category) {
                    ForEach(Category.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                let templates = matching(Self.templates).filter { $0 != featured }
                if (category == .all || category == .agents) && (!templates.isEmpty || query.isEmpty) {
                    PageSection("Agents") {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(templates.prefix(Self.limit)) { template in
                                templateRow(template)
                            }
                        }
                    }
                }
                if category == .all || category == .skills {
                    skillsSection
                }
                Text("Only persona, skills and workflows are shared — your memory, people and accounts never are.")
                    .text(.xs)
                    .foregroundStyle(Theme.fgSubtle)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 24)
        }
        .background(Theme.canvas)
        .confirmationDialog("Add to which agent?", isPresented: pickingBinding, titleVisibility: .visible, presenting: pickingFor) { skill in
            ForEach(world.agents.filter { !($0.skillIds ?? []).contains(skill.id) }) { agent in
                Button(agent.name ?? "Agent") { addSkill(skill, to: agent) }
            }
        }
    }

    /// The templates whose name, role or blurb contains the search text (all of them with none).
    private func matching(_ templates: [DiscoverTemplate]) -> [DiscoverTemplate] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? templates : templates.filter { [$0.name, $0.title, $0.blurb].contains { $0.localizedCaseInsensitiveContains(text) } }
    }

    /// The agent a template would be: its character is the one an agent with the template's id gets.
    private func avatar(_ template: DiscoverTemplate, size: CGFloat) -> some View {
        let agent = Agent(id: template.id, avatar: Avatar(character: defaultCharacter(template.id)))
        return AvatarView(agent: agent, size: size)
            .frame(width: size + 16, height: size + 16)
            .accessibilityHidden(true)
    }

    private var pickingBinding: Binding<Bool> {
        Binding(get: { pickingFor != nil }, set: { if !$0 { pickingFor = nil } })
    }

    /// Adds the skill to the agent's own skill list; the agent's list is updated when the server accepts it. A refusal or a
    /// lost connection leaves the list as it was and says so.
    private func addSkill(_ skill: Skill, to agent: Agent) {
        Task {
            do {
                try await world.addSkill(skill.id, toAgent: agent.id)
                note = nil
            } catch {
                note = "\(skill.name ?? "The skill") could not be added to \(agent.name ?? "that agent"). Try again."
            }
        }
    }

    private func featuredCard(_ template: DiscoverTemplate) -> some View {
        let tint = agentTint(Agent(id: template.id, avatar: Avatar(character: defaultCharacter(template.id))))
        return HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Featured").text(.sm, .semibold).foregroundStyle(Theme.fgMuted)
                Text("\(template.name) · \(template.title)").text(.xl, .semibold).foregroundStyle(Theme.fg)
                Text(template.blurb).text(.md).foregroundStyle(Theme.fgMuted)
                installButton(template, prominent: true)
                    .padding(.top, 4)
            }
            Spacer(minLength: 0)
            avatar(template, size: AvatarSize.profile)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(LinearGradient(colors: [tint.opacity(0.18), Theme.muted], startPoint: .topTrailing, endPoint: .bottomLeading),
                    in: RoundedRectangle(cornerRadius: 24))
    }

    private func templateRow(_ template: DiscoverTemplate) -> some View {
        HStack(alignment: .center, spacing: 12) {
            avatar(template, size: AvatarSize.lg)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(template.name) · \(template.title)").text(.md, .semibold).foregroundStyle(Theme.fg).lineLimit(1)
                Text(template.blurb).text(.sm).foregroundStyle(Theme.fgMuted).lineLimit(2)
            }
            Spacer(minLength: 0)
            installButton(template, prominent: false)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.muted, in: RoundedRectangle(cornerRadius: 14))
    }

    @ViewBuilder private var skillsSection: some View {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let skills = Array(world.skills.filter { text.isEmpty || [$0.name, $0.description].contains { ($0 ?? "").localizedCaseInsensitiveContains(text) } }.prefix(Self.limit))
        PageSection("Skills") {
            if skills.isEmpty {
                Text(text.isEmpty ? "Nothing in this category yet." : "No skill matches.").text(.sm).foregroundStyle(Theme.fgMuted)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(skills) { skill in
                        HStack(alignment: .center, spacing: 12) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(skill.name ?? "").text(.md, .semibold).foregroundStyle(Theme.fg).lineLimit(1)
                                Text(skill.description ?? "").text(.sm).foregroundStyle(Theme.fgMuted).lineLimit(2)
                            }
                            Spacer(minLength: 0)
                            Button("Add") { pickingFor = skill }
                                .buttonStyle(.plain)
                                .text(.sm, .semibold)
                                .foregroundStyle(Theme.fg)
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.muted, in: RoundedRectangle(cornerRadius: 14))
                    }
                }
            }
        }
    }

    private func installButton(_ template: DiscoverTemplate, prominent: Bool) -> some View {
        Button {
            install(template)
        } label: {
            Text("Install").text(.sm, .semibold)
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
                .background(prominent ? Theme.primary : Theme.card, in: Capsule())
                .foregroundStyle(prominent ? Theme.canvas : Theme.fg)
        }
        .buttonStyle(.plain)
        .disabled(installing)
    }

    /// Creates the agent from the template and opens its chat (the normal create flow; `createAgent` opens the chat).
    private func install(_ template: DiscoverTemplate) {
        guard !installing else { return }
        installing = true
        note = nil
        Task {
            do {
                _ = try await world.createAgent(name: template.name, role: template.title)
            } catch {
                note = "\(template.name) could not be installed. Try again."
            }
            installing = false
        }
    }
}

/// One installable agent template.
struct DiscoverTemplate: Identifiable, Hashable {
    var name: String
    var title: String
    var blurb: String
    var id: String { name }
}
