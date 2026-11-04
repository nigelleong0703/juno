import AppIntents

/// Siri and Shortcuts (backend BACKEND 7.13b): "Ask Juno" sends a message to one of your agents and returns the reply, "Open chat with
/// <agent>" opens the chat. Both work for any agent the person has; neither needs a permission switch (the person runs them). A
/// shortcut can chain "Ask Juno" with any other app's actions. The other direction is not possible: iOS has no way for an app
/// (or a server) to run a person's shortcut in the background.

/// One of the person's agents, as Shortcuts and Siri see it.
struct AgentEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Agent"
    static let defaultQuery = AgentQuery()

    var id: String
    var name: String

    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct AgentQuery: EntityStringQuery {
    private func all() async throws -> [AgentEntity] {
        guard let client = AskJunoClient.signedIn() else { return [] }
        return try await client.agents().map { AgentEntity(id: $0.id, name: $0.name ?? "Agent") }
    }

    func entities(for identifiers: [String]) async throws -> [AgentEntity] { try await all().filter { identifiers.contains($0.id) } }
    func suggestedEntities() async throws -> [AgentEntity] { try await all() }
    func entities(matching string: String) async throws -> [AgentEntity] {
        try await all().filter { $0.name.localizedCaseInsensitiveContains(string) }
    }
}

enum JunoIntentError: Error, CustomLocalizedStringResourceConvertible {
    case signedOut, failed(String)

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .signedOut: "Open Juno and sign in first."
        case .failed(let reason): "Juno couldn't do that: \(reason)"
        }
    }
}

struct AskJunoIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask Juno"
    static let description = IntentDescription("Send a message to one of your agents and get its reply back, to use in a shortcut or hear from Siri.")
    /// Runs in the background with the app closed. The system gives a background action about 30 seconds, so the wait for the
    /// reply stops well before that; a slower agent keeps working and answers in the chat.
    static let supportedModes: IntentModes = .background
    private static let waitSeconds = 22.0

    @Parameter(title: "Agent") var agent: AgentEntity
    @Parameter(title: "Message") var message: String

    static var parameterSummary: some ParameterSummary { Summary("Ask \(\.$agent) \(\.$message)") }

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        guard let client = AskJunoClient.signedIn() else { throw JunoIntentError.signedOut }
        let answer: (conversationId: String, reply: String?)
        do { answer = try await client.ask(agentId: agent.id, text: message, waitingUpTo: Self.waitSeconds) }
        catch { throw JunoIntentError.failed(error.localizedDescription) }
        let text = answer.reply ?? "Juno will reply in the app."
        return .result(value: text, dialog: IntentDialog(stringLiteral: text))
    }
}

struct OpenChatIntent: OpenIntent {
    static let title: LocalizedStringResource = "Open chat with agent"
    static let description = IntentDescription("Open your chat with one of your agents in Juno.")
    static let supportedModes: IntentModes = .foreground

    @Parameter(title: "Agent") var target: AgentEntity

    @MainActor func perform() async throws -> some IntentResult {
        guard let client = AskJunoClient.signedIn() else { throw JunoIntentError.signedOut }
        let conversationId: String
        do { conversationId = try await client.directChat(with: target.id) }
        catch { throw JunoIntentError.failed(error.localizedDescription) }
        PushRouter.shared.open(conversationId: conversationId, requestId: nil)
        return .result()
    }
}

struct JunoShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: AskJunoIntent(), phrases: ["Ask my agent in \(.applicationName)", "Ask \(.applicationName)"],
                    shortTitle: "Ask Juno", systemImageName: "bubble.left")
        AppShortcut(intent: OpenChatIntent(), phrases: ["Open a chat in \(.applicationName)", "Open \(.applicationName) chat"],
                    shortTitle: "Open chat", systemImageName: "bubble.left.and.bubble.right")
    }
}
