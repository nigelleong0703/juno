import Foundation

// Apps (contracts 0.65.0): every integration is an app the owner adds once and then turns on per agent. This file is the pure
// logic around the generated `Contract.App`: what an app is called and says, which pill it sits under, whether it needs a
// sign-in, the form its `userConfig` asks for, and what the chat connect card offers for each app it names.

extension Contract.App {
    var categoryValue: Contract.AppCategory? { category.flatMap(Contract.AppCategory.init(rawValue:)) }
    var displayName: String { name ?? id }
    var accounts: [Contract.AppInstallation] { installations ?? [] }
    /// Added: at least one account, workspace or bot.
    var isAdded: Bool { !accounts.isEmpty }
    /// Some account's sign-in was rejected after it had worked (`expired`) or never worked (`error`): the list says "Sign in".
    var needsSignIn: Bool { accounts.contains { $0.status != "connected" } }
    /// A Web & video app the server cannot add yet (it still needs a sandbox sign-in); the no-sign-in ones are available.
    var isComingSoon: Bool { categoryValue == .web && available == false }
    var canAdd: Bool { !isComingSoon && available != false }
    var isChat: Bool { categoryValue == .chat }
    /// Work, custom and web apps are turned on per agent; a chat app is on per agent in each workspace.
    var isPerAgent: Bool { categoryValue == .work || categoryValue == .custom || categoryValue == .web }
    var fields: [Contract.UserConfigField] { userConfig ?? [] }
    var prompts: [String] { (tryAsking ?? []).filter { !$0.isEmpty } }
    /// The one muted line for an app whose login is not ours: Composio holds it. Nil for the other sources.
    var sourceNote: String? { source == Contract.AppSource.composio.rawValue ? "Login held by Composio" : nil }

    /// Work and custom apps: whether the agent may use it (the server lists the agents that may; none while the app is not added).
    func isEnabled(for agentId: String) -> Bool { (enabledAgents ?? []).contains { $0.agentId == agentId } }

    /// The agent's actions policy for the app; "ask" until the server says otherwise.
    func policy(for agentId: String) -> Contract.ActionsPolicy {
        (enabledAgents ?? []).first { $0.agentId == agentId }?.actionsPolicy.flatMap(Contract.ActionsPolicy.init(rawValue:)) ?? .ask
    }

    /// The first account that needs signing in again (the one a "Sign in again" or "Reconnect" re-authorises).
    var expiredAccount: Contract.AppInstallation? { accounts.first { $0.status != "connected" } }

    var categoryName: String {
        switch categoryValue {
        case .chat: "Chat"
        case .work: "Work"
        case .web: "Web & video"
        case .custom: "Custom"
        case nil, .unknown: ""
        }
    }

    /// "Connected", "Sign in needed", "Not added", "Coming soon" or "Not available": the second word of the detail's subtitle.
    var stateName: String {
        if isComingSoon { return "Coming soon" }
        if available == false && !isAdded { return "Not available" }
        if needsSignIn { return "Sign in needed" }
        return isAdded ? "Connected" : "Not added"
    }

    func matches(_ query: String) -> Bool {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty || [name, blurb].contains { ($0 ?? "").localizedCaseInsensitiveContains(text) }
    }
}

/// The Apps page's category pills.
enum AppFilter: String, CaseIterable, Identifiable {
    case connected = "Connected", chat = "Chat", work = "Work", web = "Web & video"
    var id: String { rawValue }

    func includes(_ app: Contract.App) -> Bool {
        switch self {
        case .connected: app.isAdded
        case .chat: app.categoryValue == .chat
        case .work: app.categoryValue == .work || app.categoryValue == .custom
        case .web: app.categoryValue == .web
        }
    }

    /// Connected when something is connected, else Chat.
    static func initial(for apps: [Contract.App]) -> AppFilter { apps.contains { $0.isAdded } ? .connected : .chat }

    /// The page's rows: a search looks across every category; otherwise the pill's apps.
    static func visible(_ apps: [Contract.App], filter: AppFilter, query: String) -> [Contract.App] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? apps.filter(filter.includes) : apps.filter { $0.matches(text) }
    }

    /// The featured banners: apps that can be tried now and have example prompts, in the catalog's order (the first one leads).
    static func featured(_ apps: [Contract.App], limit: Int = 5) -> [Contract.App] {
        Array(apps.filter { !$0.prompts.isEmpty && $0.canAdd }.prefix(limit))
    }
}

// MARK: - userConfig form

/// A value sent with an install: the contract allows a string, a number or a boolean per field.
enum ConfigValue: Encodable, Equatable {
    case text(String), number(Double), flag(Bool)

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .text(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .flag(let b): try c.encode(b)
        }
    }
}

/// The fields an app asks for when it is added (an API key, a workspace URL): what is typed, what is missing or wrong, and the
/// values to send. A sensitive field is a secure input in the sheet and is never shown again.
struct UserConfigForm {
    var fields: [Contract.UserConfigField]
    var text: [String: String] = [:]
    var flags: [String: Bool] = [:]

    init(fields: [Contract.UserConfigField]) {
        self.fields = fields
        for field in fields {
            guard let key = field.key else { continue }
            switch field.default {
            case .bool(let flag)?: flags[key] = flag
            case .string(let value)? where field.type == "boolean": flags[key] = value.lowercased() == "true"
            case .string(let value)?: text[key] = value
            case .number(let value)?: text[key] = value == value.rounded() ? String(Int(value)) : String(value)
            default: break
            }
        }
    }

    private func typed(_ key: String) -> String { (text[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }

    /// A message per field that cannot be sent: required and empty, not a number, not one of the options.
    var errors: [String: String] {
        var out: [String: String] = [:]
        for field in fields {
            guard let key = field.key, field.type != "boolean" else { continue }
            let value = typed(key)
            if value.isEmpty {
                if field.required == true { out[key] = "Required" }
            } else if field.type == "number", Double(value) == nil {
                out[key] = "Enter a number"
            } else if let options = field.options, !options.isEmpty, !options.contains(value) {
                out[key] = "Pick one of the options"
            }
        }
        return out
    }

    var isValid: Bool { errors.isEmpty }

    /// Only what was filled in (an empty optional field is left out); a boolean is always sent.
    var values: [String: ConfigValue] {
        var out: [String: ConfigValue] = [:]
        for field in fields {
            guard let key = field.key else { continue }
            if field.type == "boolean" { out[key] = .flag(flags[key] ?? false); continue }
            let value = typed(key)
            if value.isEmpty { continue }
            if field.type == "number", let number = Double(value) { out[key] = .number(number) } else { out[key] = .text(value) }
        }
        return out
    }
}

// MARK: - A custom server, checked before it is added

/// What the person reviews after a custom server was probed: how it signs people in and its tools, each marked Read or Change as the
/// server's own annotations suggest (a tool nothing marked is a change). The person may flip any mark; `confirm` is what the install sends.
struct CustomAppReview: Equatable {
    var probe: Contract.ProbeCustomAppResponse
    private(set) var marks: [String: String]

    init(probe: Contract.ProbeCustomAppResponse) {
        self.probe = probe
        marks = Dictionary(uniqueKeysWithValues: (probe.tools ?? []).compactMap { tool in tool.name.map { ($0, tool.suggested == "read" ? "read" : "change") } })
    }

    var tools: [Contract.ProbedTool] { probe.tools ?? [] }
    var isOAuth: Bool { probe.auth == Contract.ProbeCustomAppResponse.AuthValue.oauth.rawValue }
    func isChange(_ tool: String) -> Bool { marks[tool] != "read" }
    mutating func flip(_ tool: String) { marks[tool] = isChange(tool) ? "read" : "change" }

    var loginLine: String { isOAuth ? "Signs in with \(probe.oauth?.issuer ?? probe.url ?? "the server")." : "Opens without signing in." }
    var confirm: Contract.CustomAppConfirm {
        Contract.CustomAppConfirm(auth: isOAuth ? Contract.CustomAppConfirm.AuthValue.oauth.rawValue : Contract.CustomAppConfirm.AuthValue.none.rawValue, tools: marks)
    }
}

/// How adding a custom server by address ended.
enum CustomAddResult: Equatable {
    case added
    /// Shown in the sheet; it stays open on the step it was on.
    case failed(String)
    /// The server cannot be added (for example it wants a key): back to the address with the server's reason.
    case notUsable(String)
    /// The server must be checked again (`CUSTOM_PROBE_REQUIRED`) or now asks for something else (`CUSTOM_PROBE_CHANGED`).
    case recheck(changed: Bool)
}

// MARK: - The chat connect card

/// What the connect card offers for one app it names.
enum ConnectAction: Equatable {
    /// The app is not added yet: add it (opens its page, or starts the sign-in).
    case add
    /// Added, but off for this agent.
    case turnOn
    /// The sign-in never worked, expired or lacks a permission: sign in again to that account ("Reconnect").
    case reconnect(connectionId: String?)
    /// Nothing left to do.
    case ready

    var isReconnect: Bool { if case .reconnect = self { true } else { false } }
}

enum ConnectCard {
    /// The problem to show for an app: what the app looks like now once the list is loaded (so the card follows the owner's
    /// progress), else the problem the request carried.
    static func problem(app: Contract.App?, agentId: String?, payload: String?) -> Contract.AppProblem? {
        let carried = payload.flatMap(Contract.AppProblem.init(rawValue:))
        guard let app else { return carried }
        if !app.isAdded { return .notAdded }
        if app.needsSignIn { return app.accounts.contains { $0.status == "expired" } ? .expired : .needsReconnect }
        if let agentId, app.isPerAgent, !app.isEnabled(for: agentId) { return .notEnabled }
        // The list cannot show a missing permission (the account reads as connected): the card keeps saying so until the server resolves it.
        return carried == .scopeMissing ? .scopeMissing : nil
    }

    /// The line under an app's name on the card.
    static func note(for problem: Contract.AppProblem?, agent: String) -> String {
        switch problem {
        case .notAdded, .notGranted, .unknown: "Not added yet"
        case .notEnabled: "Added, but off for \(agent)"
        case .needsReconnect: "Needs reconnecting"
        case .expired: "Sign-in expired"
        case .scopeMissing: "Needs another permission"
        case nil: "Ready"
        }
    }

    /// `needs_reconnect`, `expired` and `scope_missing` are all "sign in again" (`scope_missing` asks for the missing permission on
    /// the way). A problem this version does not know falls back to opening the app, never to a crash.
    static func action(problem: Contract.AppProblem?, app: Contract.App?) -> ConnectAction {
        switch problem {
        case .notEnabled: .turnOn
        case .needsReconnect, .expired, .scopeMissing: .reconnect(connectionId: app?.expiredAccount?.id ?? app?.accounts.first?.id)
        case .notAdded, .notGranted, .unknown: .add
        case nil: .ready
        }
    }
}
