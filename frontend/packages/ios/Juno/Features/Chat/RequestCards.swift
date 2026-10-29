import SwiftUI

// Request cards in the chat (and the Permissions tab): what the agent needs from the user, built from the
// DesignSystem card kit. The agent's name always comes from request.agentId. Decided requests are a slim row.

/// What a request looks like to the user; picked from its kind and payload.
enum RequestFlavor {
    case decision, checkout, send, command, generic, question, secure, takeover, signin, connect

    init(_ r: AgentRequest) {
        let p = r.payload
        switch r.kind {
        case "question": self = .question
        case "secure_input": self = .secure
        case "computer": self = .takeover
        case "signin": self = .signin
        case "connect": self = .connect
        default:
            let action = (p?.action ?? "").lowercased()
            if p?.brief != nil { self = .decision }
            else if p?.purchase != nil { self = .checkout }
            else if p?.draft != nil || ["send", "reply", "email", "mail", "message", "sms"].contains(where: { action.contains($0) }) { self = .send }
            else if ["bash", "shell", "command", "exec", "terminal"].contains(where: { action.contains($0) }) { self = .command }
            else { self = .generic }
        }
    }
}

extension AgentRequest {
    var flavor: RequestFlavor { RequestFlavor(self) }
    var fieldKinds: Set<String> { Set((payload?.fields ?? []).compactMap(\.kind)) }

    /// "Ask the user for" in words: password / card details / code.
    var secretNoun: String {
        let kinds = fieldKinds
        if kinds.contains(where: { $0.hasPrefix("card") }) { return "card details" }
        if kinds == ["password"] { return "password" }
        if kinds == ["otp"] { return "code" }
        return "details"
    }

    /// Tool names like "gmail_send_email" or "browser.click" as words.
    var actionWords: String {
        (payload?.action ?? "use a tool").replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: ".", with: " ").lowercased()
    }
}

func requestIcon(_ r: AgentRequest) -> String {
    switch r.flavor {
    case .decision: DecisionWords.symbol(r.payload?.brief?.primary)
    case .checkout: "cart"
    case .send: "envelope"
    case .command: "exclamationmark.shield"
    case .question: "questionmark.circle"
    case .secure: "lock"
    case .takeover: "display"
    case .signin: "key"
    case .connect: "link"
    case .generic: "hand.raised"
    }
}

struct RequestCard: View {
    var request: AgentRequest
    /// The Permissions tab's "Waiting on you": no screenshots, otherwise the same card.
    var compact = false

    var body: some View {
        Group {
            if request.status == "pending" { PendingRequestCard(request: request, compact: compact) }
            else { ResolvedRequestRow(request: request) }
        }
        .frame(maxWidth: 560)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Pending

private struct PendingRequestCard: View {
    @Environment(World.self) private var world
    var request: AgentRequest
    var compact: Bool

    @State private var draftText = ""
    @State private var editing = false
    @State private var takingOver = false
    @State private var answering = false
    @State private var answerErrors: [String: String] = [:]

    private var name: String { world.agent(request.agentId)?.name ?? "Your agent" }
    private var p: RequestPayload? { request.payload }
    private func decide(_ decision: String, edited: String? = nil) { world.resolve(request.id, decision: decision, editedDraft: edited) }

    var body: some View {
        switch request.flavor {
        case .decision: DecisionCard(request: request, compact: compact)
        case .checkout: checkout
        case .send: send
        case .command: command
        case .generic: generic
        case .question: question
        case .secure: secure
        case .takeover: takeover
        case .signin: signin
        case .connect: connect
        }
    }

    // MARK: Kinds

    private var checkout: some View {
        let merchant = p?.purchase?.merchant ?? p?.site ?? "the merchant"
        return RequestCardShell(icon: "cart", title: "Checkout · \(name) wants to place an order at \(merchant)",
                                guidance: "Verify the details and terms of your order on the merchant website carefully before approving.", notice: p?.notice) {
            CheckoutDetails(request: request, compact: compact)
        } actions: {
            CardButtons(secondary: "Deny", primary: "Allow", onSecondary: { decide("denied") }, onPrimary: { decide("approved") }, id: "checkout")
        }
    }

    private var send: some View {
        let recipient = p?.recipient ?? p?.target
        let action = (p?.action ?? "").lowercased()
        let verb = action.contains("mail") ? "email" : "message"
        let draft = p?.draft
        let initials = recipient.map { String($0.split(separator: " ").prefix(2).compactMap(\.first)) } ?? ""
        return RequestCardShell(icon: "envelope", title: "Send · \(name) wants to \(recipient.map { "\(verb) \($0)" } ?? "send a message")",
                                guidance: p?.why ?? "Review the message before it goes out.", notice: p?.notice) {
            if let recipient {
                CardTile(title: recipient, subtitle: p?.target != recipient ? p?.target : nil) { TileBadge(symbol: nil, initials: initials.uppercased()) }
            }
            if let draft {
                CardTextBlock(subject: draft.subject, text: draftText.isEmpty ? (draft.body ?? "") : draftText) {
                    Button { draftText = draftText.isEmpty ? (draft.body ?? "") : draftText; editing = true } label: { CardChip(text: "Edit", symbol: "pencil") }
                        .buttonStyle(.plain)
                }
            } else if let target = p?.target, recipient == nil {
                CardTextBlock(subject: nil, text: target) { EmptyView() }
            }
        } actions: {
            CardButtons(secondary: "Deny", primary: "Send", onSecondary: { decide("denied") },
                        onPrimary: { decide("approved", edited: draftText.isEmpty || draftText == draft?.body ? nil : draftText) }, id: "send")
        }
        .onAppear { draftText = draft?.body ?? "" }
        .sheet(isPresented: $editing) { DraftEditSheet(text: $draftText, title: name) }
    }

    private var command: some View {
        RequestCardShell(icon: "exclamationmark.shield", title: "Run command · \(name) wants to run a command on its computer", guidance: p?.why ?? request.summary, notice: p?.notice) {
            CardTile(title: p?.target ?? "", mono: true) { Image(systemName: "terminal").text(.base).foregroundStyle(Theme.fgMuted) }
        } actions: {
            CardButtons(secondary: "Deny", primary: "Run once", onSecondary: { decide("denied") }, onPrimary: { decide("approved") }, id: "command")
        }
    }

    private var generic: some View {
        let target = p?.target ?? p?.site ?? p?.app
        return RequestCardShell(icon: "hand.raised", title: "Approval · \(name) wants to \(request.actionWords)", guidance: p?.why ?? request.summary, notice: p?.notice) {
            if let target, !target.isEmpty { CardTile(title: target, mono: true) { EmptyView() } }
        } actions: {
            CardButtons(secondary: "Deny", primary: "Allow", onSecondary: { decide("denied") }, onPrimary: { decide("approved") }, id: "approval")
        }
    }

    private var question: some View {
        let doc = p?.ui
        return RequestCardShell(icon: "questionmark.circle", title: (world.isQuiet(request) ? "" : "Question · ") + (doc?.headline ?? request.title ?? name), guidance: nil) {
            if let doc {
                UiDocView(doc: doc, answering: UiDocAnswering(recorded: nil, errors: answerErrors, busy: answering,
                                                              openForm: { world.sheet = .question(request.id) }) { answers in
                    send(answers)
                })
            }
        } actions: { EmptyView() }
    }

    /// Sends the answers and waits for the server; its per-id reasons (400 `error.fields`) show under the choice.
    private func send(_ answers: [String: String]) {
        answering = true; answerErrors = [:]
        Task {
            do { try await world.answerQuestion(request.id, answers: answers) }
            catch APIError.fields(_, let found) { answerErrors = found }
            catch { answerErrors = [request.payload?.ui?.interactive.flatMap(Self.interactiveId) ?? "": "Could not send. Try again."] }
            answering = false
        }
    }

    private static func interactiveId(_ block: UiBlock) -> String? {
        switch block { case .choices(let c): c.id; case .fields(let f): f.id; default: nil }
    }

    private var secure: some View {
        let fields = p?.fields ?? []
        let first = fields.first?.label ?? request.secretNoun.capitalized
        let site = p?.site ?? p?.url.flatMap { URL(string: $0)?.host }
        return RequestCardShell(icon: "lock", title: "Secure input · \(name) needs your \(request.secretNoun)",
                                guidance: p?.reason ?? request.summary) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "lock").text(.xs).foregroundStyle(Theme.fgSubtle)
                Text("End-to-end encrypted — only your computer can read this.").text(.xs).foregroundStyle(Theme.fgMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            CardTile(title: first, subtitle: [fields.count > 1 ? "\(fields.count) fields" : nil, site.map { "for \($0)" }].compactMap { $0 }.joined(separator: " · ")) {
                TileBadge(symbol: "lock")
            }
        } actions: {
            CardButtons(secondary: "Cancel", primary: "Enter securely", onSecondary: { world.cancelSecureInput(request.id) },
                        onPrimary: { world.sheet = .secureInput(request.id) }, id: "secure")
        }
    }

    private var takeover: some View {
        let controlling = world.computer?.controller == "user"
        let agentId = request.agentId ?? ""
        return RequestCardShell(icon: "display", title: controlling ? "You're in control" : "Take over · \(name) needs your help on its computer",
                                guidance: controlling ? "\(name) is paused. Click and type on the screen as you normally would." : (p?.reason ?? request.summary)) {
            if !compact {
                CardPreview(image: world.screenshots[agentId]) { CardChip(text: controlling ? "You" : "Live", live: Theme.success) }
                    .contentShape(.rect).onTapGesture { takingOver = true }
                    .task { await world.refreshScreen(agentId) }
            }
        } actions: {
            if controlling {
                CardPrimaryButton(title: "Return control", id: "takeover-return") { world.returnControl(request) }
            } else {
                CardButtons(secondary: "Skip", primary: "Take over", onSecondary: { decide("denied") }, onPrimary: { takingOver = true }, id: "takeover")
            }
        }
        .fullScreenCover(isPresented: $takingOver) { TakeoverView(agentId: agentId, request: request) }
    }

    /// A task needs apps that are not added, are off for this agent, or whose sign-in expired: a block per app with the one action
    /// that fixes it. A routine that waits on them also offers "Not now"; the agent offering apps in chat has nothing to dismiss.
    @ViewBuilder private var connect: some View {
        if (p?.routineId ?? "").isEmpty {
            ConnectRequestCard(request: request, title: request.title ?? "Connect apps", guidance: nil, dismissable: false) { decide("denied") }
        } else {
            ConnectRequestCard(request: request, title: "Connect \u{00B7} \(name) needs \(p?.label ?? "an app") to run a routine",
                               guidance: "It stays paused until one of these is connected.", dismissable: true) { decide("denied") }
        }
    }

    private var signin: some View {
        RequestCardShell(icon: "key", title: "Sign in · \(name) needs you to sign in\(p?.site.map { " to \($0)" } ?? "")", guidance: p?.reason ?? request.summary) {
            CardButtons(secondary: "Deny", primary: "Open sign-in", onSecondary: { decide("denied") }, onPrimary: { decide("approved") }, id: "signin")
        }
    }
}

/// What an order is: the page screenshot and the server's document, else the items, card and total. Shared by the
/// checkout card and the decision card of a purchase.
struct CheckoutDetails: View {
    @Environment(World.self) private var world
    var request: AgentRequest
    var compact: Bool
    @State private var preview: UIImage?
    @State private var viewing = false

    var body: some View {
        let p = request.payload
        let purchase = p?.purchase
        VStack(alignment: .leading, spacing: 14) {
            if !compact, p?.ui?.isRenderable != true, let id = p?.preview?.libraryId {
                CardPreview(image: preview) {
                    Button { viewing = true } label: { CardChip(text: "Review order", symbol: "arrow.up.left.and.arrow.down.right") }.buttonStyle(.plain)
                }
                .task { preview = await world.previewImage(id) }
                .sheet(isPresented: $viewing) { ImageViewer(image: preview) }
            }
            if let ui = p?.ui, ui.isRenderable {
                UiDocView(doc: ui)
            } else {
                ForEach(Array((purchase?.items ?? []).enumerated()), id: \.offset) { _, item in
                    CardRow(label: [item.quantity.map { "\($0) ×" }, item.name].compactMap { $0 }.joined(separator: " "), value: item.price ?? "")
                }
                if let method = purchase?.paymentMethod, !method.isEmpty {
                    CardTile(title: method, subtitle: "Saved card") { TileBadge(symbol: "creditcard") }
                }
                if let total = purchase?.total, !total.isEmpty {
                    CardRow(label: "Estimated total", value: [purchase?.currency.flatMap { total.first?.isNumber == true ? $0 : nil }, total].compactMap { $0 }.joined(separator: " "))
                }
            }
        }
    }
}

/// The send card's message editor: a sheet, so typing never happens inside the transcript cell.
struct DraftEditSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var text: String
    var title: String
    @State private var draft = ""

    var body: some View {
        JunoSheet(icon: "square.and.pencil", title: title, guidance: "Edit the message before it is sent.",
                  primary: "Done", primaryEnabled: !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, long: true, id: "draft",
                  onPrimary: { text = draft; dismiss() }, onCancel: { dismiss() }) {
            JunoFormField(label: "Message") {
                TextField("Message", text: $draft, axis: .vertical).lineLimit(6...20).padding(.vertical, 12)
                    .accessibilityIdentifier("draft-editor").inputField()
            }
        }
        .onAppear { draft = text }
    }
}

/// A picture to look at closely: pinch-free but scrollable both ways.
struct ImageViewer: View {
    @Environment(\.dismiss) private var dismiss
    var image: UIImage?
    var body: some View {
        NavigationStack {
            ScrollView([.horizontal, .vertical]) {
                if let image { Image(uiImage: image).resizable().scaledToFit().frame(minWidth: 600) }
            }
            .background(Theme.canvas)
            .toolbar { CloseButton() }
        }
    }
}

// MARK: - Decided

struct ResolvedRequestRow: View {
    @Environment(World.self) private var world
    var request: AgentRequest

    var body: some View {
        let label = Self.label(request)
        ResolvedCardRow(outcome: label.outcome, title: label.title, subtitle: label.subtitle) {
            RequestFacts(request: request)
        }
    }

    /// "Sent · Email to Mei Lin", "Denied · Run command", "Entered securely · Apple ID password".
    static func label(_ r: AgentRequest) -> (outcome: CardOutcome, title: String, subtitle: String?) {
        let p = r.payload
        // The agent withdrew its own request in chat: show the user's words, not an outcome.
        if let d = r.decision, d.reason == "cancelled", let by = d.by, by == r.agentId, let note = d.note, !note.isEmpty {
            return (.neutral, "Withdrawn in chat: \(note)", nil)
        }
        let ok = r.status == "approved" || r.status == "answered"
        let outcome: CardOutcome = ok ? .done : r.status == "denied" && r.flavor != .connect ? .refused : .neutral
        let status: String
        let subject: String?
        // The server's own verdict in words ("Allowed by your rule", "Sent back to change") for an approval.
        if [.decision, .checkout, .send, .command, .generic].contains(r.flavor), let words = DecisionWords.outcome(r.outcome) {
            return (DecisionWords.outcomeTone(r.outcome), words, r.sentence)
        }
        switch r.flavor {
        case .decision: status = ok ? "Allowed" : "Denied"; subject = r.sentence
        case .checkout: status = ok ? "Allowed" : "Denied"; subject = "Order at \(p?.purchase?.merchant ?? p?.site ?? "the merchant")"
        case .send: status = ok ? "Sent" : "Denied"; subject = p?.recipient.map { "To \($0)" } ?? p?.draft?.subject
        case .command: status = ok ? "Ran once" : "Denied"; subject = p?.target
        case .question: status = ok ? "Answered" : "Skipped"; subject = [p?.ui?.headline, p?.ui.map { UiAnswers.summary($0, p?.answers) }].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        case .secure: status = ok ? "Entered securely" : "Cancelled"; subject = p?.fields?.first?.label ?? r.secretNoun
        case .takeover: status = ok ? "Handed back" : "Skipped"; subject = p?.reason ?? "Take over"
        case .signin: status = ok ? "Signed in" : "Denied"; subject = p?.site
        case .connect: status = ok ? "Connected" : "Not now"; subject = p?.label
        case .generic: status = ok ? "Allowed" : "Denied"; subject = r.actionWords.capitalized
        }
        let final = r.status == "expired" ? "Expired" : status
        return (outcome, final, subject)
    }
}

/// The details under an expanded decided row: what, why, the answers, and when.
struct RequestFacts: View {
    @Environment(World.self) private var world
    var request: AgentRequest
    @State private var preview: UIImage?

    var body: some View {
        let p = request.payload
        VStack(alignment: .leading, spacing: 8) {
            if request.flavor == .question, let ui = p?.ui { UiDocView(doc: ui, answering: UiDocAnswering(recorded: p?.answers ?? [:], onAnswer: { _ in })) }
            if p?.purchase != nil, let ui = p?.ui, ui.isRenderable {
                UiDocView(doc: ui)
            } else {
                if let id = p?.preview?.libraryId, p?.purchase != nil {
                    CardPreview(image: preview) { EmptyView() }.task { preview = await world.previewImage(id) }
                }
                ForEach(Array((p?.purchase?.items ?? []).enumerated()), id: \.offset) { _, item in
                    CardRow(label: item.name ?? "", value: item.price ?? "")
                }
                if let total = p?.purchase?.total { CardRow(label: "Total", value: total) }
            }
            if let target = p?.target, request.flavor == .command || request.flavor == .generic {
                Text(target).font(.system(.footnote, design: .monospaced)).foregroundStyle(Theme.fg)
            }
            if let body = p?.draft?.body { Text(body).text(.base).foregroundStyle(Theme.fgMuted) }
            if let why = p?.brief?.why ?? p?.why ?? p?.reason ?? (request.flavor == .question ? nil : request.summary) { Text(why).text(.base).foregroundStyle(Theme.fgMuted) }
            if let denied = p?.brief?.ifDenied, !denied.isEmpty { Text("If you said no: \(denied)").text(.sm).foregroundStyle(Theme.fgSubtle) }
            Text([world.agent(request.agentId)?.name, request.resolvedAt.map { Fmt.ago($0) }].compactMap { $0 }.joined(separator: " · "))
                .text(.sm).foregroundStyle(Theme.fgSubtle)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The connect card (contracts 0.65.0): the apps a task needs, one block each, with the one action that fixes what is wrong:
/// "Add <App>" when it is not added, "Turn on for <agent>" when it is off for this agent, "Reconnect" when its sign-in never worked,
/// expired or lacks a permission. The blocks follow the owner's progress (the app list), so a fixed app reads "Ready". The card only offers the action.
/// Four blocks, then "Show more". `mac` keeps its own row.
private struct ConnectRequestCard: View {
    @Environment(World.self) private var world
    var request: AgentRequest
    var title: String
    var guidance: String?
    var dismissable: Bool
    var notNow: () -> Void
    @State private var expanded = false
    @State private var installer = AppInstaller()
    private static let cap = 4

    private var agentId: String? { request.agentId }
    private var appIds: [String] { request.payload?.appIds ?? [] }

    var body: some View {
        let shown = expanded ? appIds : Array(appIds.prefix(Self.cap))
        RequestCardShell(icon: "link", title: title, guidance: guidance) {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(shown, id: \.self) { block($0) }
                if appIds.count > Self.cap {
                    Button { withAnimation(.snappy(duration: 0.2)) { expanded.toggle() } } label: {
                        Text(expanded ? "Show fewer" : "Show \(appIds.count - Self.cap) more").text(.sm, .medium).foregroundStyle(Theme.fgMuted)
                    }
                    .buttonStyle(.plain)
                }
                if let line = installer.error { Text(line).text(.sm).foregroundStyle(Theme.danger) }
            }
        } actions: {
            if dismissable {
                Button(action: notNow) { Text("Not now").frame(maxWidth: .infinity) }
                    .buttonStyle(WebButton(variant: .secondary, size: .large))
                    .accessibilityIdentifier("connect-not-now")
            }
        }
        .task { if world.apps == nil { await world.refreshApps() } }
        .appInstaller(installer)
    }

    @ViewBuilder private func block(_ id: String) -> some View {
        if id == "mac" {
            HStack(alignment: .top, spacing: 12) {
                BrandIcon(symbol: "desktopcomputer", size: 32)
                MacAccessRow(agentId: agentId)
                Spacer(minLength: 0)
            }
        } else {
            let app = world.app(id)
            let problem = ConnectCard.problem(app: app, agentId: agentId, payload: request.payload?.problems?[id])
            let action = ConnectCard.action(problem: problem, app: app)
            let name = app?.displayName ?? id
            HStack(spacing: 12) {
                if let app { AppIcon(app: app, size: 32) } else { BrandIcon(catalogId: id, size: 32) }
                VStack(alignment: .leading, spacing: 1) {
                    Text(name).text(.base, .medium).foregroundStyle(Theme.fg).lineLimit(1)
                    Text(ConnectCard.note(for: problem, agent: world.agent(agentId)?.name ?? "this agent"))
                        .text(.sm).foregroundStyle(action.isReconnect ? Theme.warning : Theme.fgMuted).lineLimit(2)
                    if let note = app?.sourceNote { Text(note).text(.xs).foregroundStyle(Theme.fgMuted).lineLimit(1) }
                }
                Spacer(minLength: 8)
                trailing(action, id: id, app: app, name: name)
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("connect-app-\(id)")
        }
    }

    @ViewBuilder private func trailing(_ action: ConnectAction, id: String, app: Contract.App?, name: String) -> some View {
        switch action {
        case .add:
            pill("Add \(name)") {
                // A work app starts its sign-in here; a chat app or an unknown one opens its page to choose how.
                if let app, app.isPerAgent, app.canAdd { installer.start(app) } else { world.pendingRoute = .app(id) }
            }
        case .turnOn:
            pill("Turn on for \(world.agent(agentId)?.name ?? "this agent")") {
                guard let agentId else { return }
                Task { @MainActor in
                    do { try await world.setAgentApp(agentId, id, enabled: true) } catch where !error.isCancellation { installer.error = error.localizedDescription } catch {}
                }
            }
        case .reconnect(let connectionId):
            pill("Reconnect") {
                if let app { installer.start(app, connectionId: connectionId) } else { world.pendingRoute = .app(id) }
            }
        case .ready:
            Label("Ready", systemImage: "checkmark").text(.sm).foregroundStyle(Theme.fgMuted)
        }
    }

    private func pill(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Text(title) }
            .buttonStyle(WebButton(variant: .secondary, size: .sm))
            .disabled(installer.busy)
    }
}
