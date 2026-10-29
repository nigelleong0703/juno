import SwiftUI

/// The ☰ drawer, measured off the ChatGPT iOS app (Claude's is the same pattern), in pt on a 440pt-wide
/// iPhone: drawer 75% of the screen (the page stays visible, dimmed, on the right); title 22pt bold at a 33pt
/// inset with a 44pt round glass search button top right (the size of the page's ☰; it opens `SearchPage`); rows 44pt tall, ~20pt icon at 34pt, 17pt regular text at
/// 63pt; selected row a 16pt-radius fill inset 10pt; section headers 17pt semibold; plain recents; at the bottom
/// a "New chat" pill and a 44pt round settings button.
struct Sidebar: View {
    @Environment(World.self) private var world
    @State private var showSearch = false
    private enum CreationEntry: String, Identifiable {
        case chat, agent
        var id: String { rawValue }
    }
    @State private var creationEntry: CreationEntry?
    @State private var pendingChatId: String?
    @State private var showSettings = false

    var body: some View {
        let agents = world.agents
        let recents = world.recentConversations
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Juno").font(.system(size: 22, weight: .bold)).foregroundStyle(Theme.fg)
                Spacer()
                RoundGlassButton(symbol: "magnifyingglass", label: "Search") { showSearch = true }
            }
            .frame(height: 44)
            .padding(.leading, 21).padding(.trailing, 16)

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(SidebarTab.all, id: \.value) { t in
                        SidebarRow(selected: world.tab == t.value) {
                            world.tab = t.value; close()
                        } label: {
                            SidebarRowLabel { Image(systemName: t.symbol).font(.system(size: 18)) } text: { Text(t.title) }
                        }
                    }
                    // Apps (replaces Plugins › Connectors) and Skills, which stays its own page.
                    ForEach([("puzzlepiece.extension", "Apps", Route.apps), (GlobalPage.skills.icon, "Skills", Route.page(.skills))], id: \.1) { symbol, title, route in
                        SidebarRow(selected: false) {
                            world.pendingRoute = route; close()
                        } label: {
                            SidebarRowLabel { Image(systemName: symbol).font(.system(size: 18)) } text: { Text(title) }
                        }
                    }
                    SidebarHeader("Your agents") {
                        Button { creationEntry = .agent } label: { Image(systemName: "plus").font(.system(size: 16, weight: .medium)) }
                            .foregroundStyle(Theme.fg).accessibilityLabel("New agent")
                    }
                    ForEach(agents) { agent in
                        let needs = !world.needsYou(of: agent.id).isEmpty
                        SidebarRow(selected: isCurrent(agent)) { open(agent) } label: {
                            SidebarRowLabel {
                                AvatarView(agent: agent, size: 22)
                                    .agentZoomSource("sidebar-\(agent.id)")
                                    .overlay(alignment: .bottomTrailing) {
                                        if AgentDot.shows(agent.status, needsYou: needs) {
                                            AgentDot(status: agent.status, needsYou: needs).scaleEffect(0.8)
                                                .padding(1).background(Theme.canvas, in: .circle).offset(x: 3, y: 3)
                                        }
                                    }
                            } text: { Text(agent.name ?? "") }
                        }
                        .contextMenu {
                            // The drawer stays open so the page zooms back into this row's avatar.
                            Button("Profile", systemImage: "person.crop.circle") { world.openAgentPage(agent.id, from: "sidebar-\(agent.id)") }
                        }
                    }
                    if !recents.isEmpty {
                        SidebarHeader("Recents")
                        ForEach(recents.prefix(20)) { c in
                            SidebarRow(selected: world.currentConversationId == c.id && world.tab == "chat") {
                                world.openChat(c.id); close()
                            } label: {
                                Text(world.title(of: c)).font(.system(size: 16)).foregroundStyle(Theme.fg).lineLimit(1)
                                    .padding(.leading, 11)
                            }
                        }
                    }
                }
                .padding(.horizontal, 10).padding(.top, 8).padding(.bottom, 16)
            }
            .scrollIndicators(.hidden)

            HStack {
                Button { creationEntry = .chat } label: {
                    Label("New chat", systemImage: "square.and.pencil").font(.system(size: 17, weight: .semibold))
                }
                .buttonStyle(.glassProminent).buttonBorderShape(.capsule).controlSize(.large).tint(Theme.primary)
                Spacer()
                RoundGlassButton(symbol: "gearshape", label: "Settings") { showSettings = true }
            }
            .padding(.leading, 26).padding(.trailing, 16).padding(.bottom, 8)
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.canvas)
        .sheet(item: $creationEntry, onDismiss: {
            guard let id = pendingChatId else { return }
            pendingChatId = nil
            world.openChat(id)
        }) { entry in
            NewChatSheet(startsWithNewAgent: entry == .agent) { id in
                pendingChatId = id
                creationEntry = nil
                close()
            }
            .junoSheetPresentation(long: true)
        }
        .sheet(isPresented: $showSettings) { MorePage().junoSheetPresentation(long: true) }
        .fullScreenCover(isPresented: $showSearch) { SearchPage() }
    }

    private func isCurrent(_ agent: Agent) -> Bool {
        world.tab == "chat" && world.currentConversationId == world.directConversation(for: agent.id)?.id
    }

    private func open(_ agent: Agent) { withAnimation(.snappy(duration: 0.28)) { world.openFromSidebar(agent) } }

    private func close() { withAnimation(.snappy(duration: 0.28)) { world.sidebarOpen = false } }
}

/// Section header: 17pt semibold, primary colour, with an optional trailing control.
struct SidebarHeader<Trailing: View>: View {
    var title: String
    var trailing: Trailing
    init(_ title: String, @ViewBuilder trailing: () -> Trailing = { EmptyView() }) { self.title = title; self.trailing = trailing() }
    var body: some View {
        HStack {
            Text(title).font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.fg)
            Spacer()
            trailing
        }
        // Lines up with the row icons (row inset 10 + label inset 11), as in ChatGPT.
        .padding(.leading, 21).padding(.trailing, 13).padding(.top, 22).padding(.bottom, 6)
    }
}

/// An icon in a 24pt column and 17pt regular text (row inset 10 + padding 11 ≈ ChatGPT).
struct SidebarRowLabel<I: View, T: View>: View {
    @ViewBuilder var icon: I
    @ViewBuilder var text: T
    var body: some View {
        HStack(spacing: 12) {
            icon.frame(width: 24).foregroundStyle(Theme.fg)
            text.font(.system(size: 17)).foregroundStyle(Theme.fg).lineLimit(1)
        }
        .padding(.leading, 11)
    }
}

/// A 44pt row; the current one gets a 16pt-radius fill. A tap, not a Button: a Button also fires when a slide
/// starts and ends on the same row, so swiping across the drawer opened whatever the finger let go on.
struct SidebarRow<Label: View>: View {
    var selected: Bool
    var action: () -> Void
    @ViewBuilder var label: Label
    var body: some View {
        label.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(selected ? Theme.muted : .clear, in: .rect(cornerRadius: 16))
            .contentShape(.rect)
            .onTapGesture(perform: action)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
    }
}

/// The tab bar's pages, listed at the top of the drawer.
struct SidebarTab {
    var value: String, title: String, symbol: String
    /// The five tabs, in order (owner-approved 2026-10-26).
    static let all = [
        SidebarTab(value: "today", title: "Today", symbol: "sun.max"),
        SidebarTab(value: "chat", title: "Chat", symbol: "bubble.left"),
        SidebarTab(value: "team", title: "Team", symbol: "person.2"),
        SidebarTab(value: "discover", title: "Discover", symbol: "square.grid.2x2"),
        SidebarTab(value: "library", title: "Library", symbol: "folder"),
    ]
}

/// ☰ at the leading edge of a top-level page's navigation bar.
struct SidebarButton: ToolbarContent {
    @Environment(World.self) private var world
    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button("Menu", systemImage: "line.3.horizontal") {
                withAnimation(.snappy(duration: 0.28)) { world.sidebarOpen = true }
            }
        }
    }
}

/// Create an agent: a name and, optionally, its role. Opens its chat when done.
struct NewAgentSheet: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var embedded = false
    var onCreated: ((String) -> Void)? = nil
    @State private var name = ""
    @State private var role = ""
    @State private var character = "mint"
    @State private var saving = false
    @State private var error: String?
    @FocusState private var focusedField: Field?

    private enum Field { case name, role }

    var body: some View {
        Group {
            if embedded { form }
            else { NavigationStack { form }.presentationDetents([.large]) }
        }
    }

    private var form: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(spacing: 8) {
                    AvatarView(agent: Agent(id: "new-agent-preview", avatar: Avatar(character: character)), size: 112)
                        .frame(width: 128, height: 128)
                        .accessibilityHidden(true)
                    Text(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Your agent" : name)
                        .text(.xl, .semibold)
                        .foregroundStyle(Theme.fg)
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(.top, 12)

                AvatarCharacterPicker(selection: $character, agentId: "new-agent-preview", avatarSize: 64,
                                      cellHeight: 92, spacing: 12, accessibilityPrefix: "new-agent-avatar", isDisabled: saving)

                VStack(alignment: .leading, spacing: 10) {
                    Text("About").text(.lg, .semibold).foregroundStyle(Theme.fg)
                    VStack(alignment: .leading, spacing: 0) {
                        labeledField("Name", placeholder: "Agent name", text: $name, field: .name)
                        Rectangle().fill(Theme.border.opacity(0.7)).frame(height: 1).padding(.leading, 14)
                        labeledField("Role (optional)", placeholder: "What this agent does", text: $role, field: .role)
                    }
                    .background(Theme.panel, in: RoundedRectangle(cornerRadius: Radius.lg))
                    .overlay(RoundedRectangle(cornerRadius: Radius.lg).stroke(Theme.border.opacity(0.55), lineWidth: 1))
                    Text("Leave the role empty and Juno suggests one after your first few messages.")
                        .text(.sm).foregroundStyle(Theme.fgMuted)
                }

                ModelProviderNotice(conversationId: nil).padding(.horizontal, -16)

                if let error {
                    Text(error).text(.base).foregroundStyle(Theme.danger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("new-agent-error")
                }
            }
            .padding(.top, 8)
        }
        .scrollDismissesKeyboard(.interactively)
        .scrollIndicators(.hidden)
        // Its own corner-safe margins, so the form reads the same wherever it is hosted (sheet, pushed in New chat).
        .junoSheetMargins()
        .background(Theme.canvas.ignoresSafeArea())
        .tint(Theme.fg)
        .pageHeader("New agent")
        .navigationBarBackButtonHidden(saving)
        .interactiveDismissDisabled(saving)
        .toolbar {
            if !embedded {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
            }
            ToolbarItem(placement: .confirmationAction) {
                if saving { ProgressView() } else {
                    Button { create() } label: {
                        Text("Create")
                    }
                    .buttonStyle(.glassProminent)
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .disabled(saving)
        .onDisappear { if !embedded { world.starterText = nil } }
    }

    private func labeledField(_ label: String, placeholder: String, text: Binding<String>, field: Field) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).text(.xs, .medium).foregroundStyle(Theme.fgMuted)
            TextField(placeholder, text: text)
                .focused($focusedField, equals: field)
                .submitLabel(field == .name ? .next : .done)
                .onSubmit {
                    if field == .name { focusedField = .role }
                    else { focusedField = nil }
                }
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled(field == .name)
                .textFieldStyle(.plain)
                .text(.base)
                .foregroundStyle(Theme.fg)
                .accessibilityLabel(label)
                .accessibilityIdentifier(field == .name ? "new-agent-name" : "new-agent-role")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
    }

    private func create() {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty, !saving else { return }
        focusedField = nil
        saving = true
        error = nil
        Task { @MainActor in
            do {
                let chatId = try await world.createAgent(name: trimmedName, role: role, avatar: Avatar(character: character),
                                                         openChat: !embedded)
                if embedded { onCreated?(chatId) } else {
                    // An inspiration starter that had no agent yet: its text waits in the new agent's composer.
                    if let text = world.starterText { world.drafts[chatId] = text; world.starterText = nil }
                    dismiss()
                }
            } catch {
                self.error = "Couldn't create the agent: \(error.localizedDescription)"
                saving = false
            }
        }
    }
}
