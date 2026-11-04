import Foundation

/// What the Siri / Shortcuts intents need of the server (backend BACKEND 7.13b): the agents, the person's direct chat with one, and
/// "send this message, then wait for the reply". It signs in with the saved session, so an intent works with the app closed (the
/// system runs the intent in the app's process without a window). It only talks; it never touches the app's in-memory state.
struct AskJunoClient {
    let api: API

    /// The saved session, or nil when nobody is signed in on this iPhone.
    static func signedIn() -> AskJunoClient? { SessionStore.load().map { AskJunoClient(api: API(session: $0)) } }

    func agents() async throws -> [Agent] { try await api.list("/v1/agents?limit=200", as: Agent.self) }

    /// The person's own direct chat with the agent; made when there is none yet.
    func directChat(with agentId: String) async throws -> String {
        var query = URLComponents()
        query.path = "/v1/conversations"
        query.queryItems = [URLQueryItem(name: "agentId", value: agentId), URLQueryItem(name: "kind", value: "direct")]
        guard let path = query.string else { throw APIError.badServer }
        let chats = try await api.list(path, as: Conversation.self)
        if let existing = chats.first(where: { $0.kind == "direct" && $0.agentIds == [agentId] && $0.memberIds == [api.session.userId] && !$0.isChannelChat }) { return existing.id }
        struct ChatBody: Encodable { var kind = "direct"; var memberAgentIds: [String]; var requestId: String }
        let raw = try await api.post("/v1/conversations", ChatBody(memberAgentIds: [agentId], requestId: "shortcut-" + agentId))
        struct Envelope: Decodable { var conversation: Conversation }
        return try (try? isoDecoder.decode(Conversation.self, from: raw))?.id ?? isoDecoder.decode(Envelope.self, from: raw).conversation.id
    }

    /// Sends `text` to the agent's chat as the person and waits up to `seconds` for the agent's reply. The reply is the agent's
    /// messages that arrived after the send (a short pause after the first lets a second part land too); nil when none came in time:
    /// the agent keeps working and answers in the app.
    func ask(agentId: String, text: String, waitingUpTo seconds: Double) async throws -> (conversationId: String, reply: String?) {
        let started = Date()
        let conversationId = try await directChat(with: agentId)
        let message = Item(id: UUID().uuidString, conversationId: conversationId, at: started, type: "user_message", authorId: api.session.userId, text: text)
        let data = try await api.post("/v1/conversations/\(conversationId)/runs", UserMessageRun.input(for: message, conversationId: conversationId, authorId: api.session.userId))
        // The server's time for the message, not this phone's clock, says which replies came after it.
        struct Accepted: Decodable { var item: Item? }
        let sentAt = (try? isoDecoder.decode(Accepted.self, from: data))?.item?.at ?? Date()
        let deadline = started.addingTimeInterval(seconds)
        var found: [Item] = []
        while Date() < deadline && found.isEmpty {
            try await Task.sleep(nanoseconds: 1_500_000_000)
            found = try await replies(in: conversationId, since: sentAt)
        }
        guard !found.isEmpty else { return (conversationId, nil) }
        // A reply is in; one more look lets a second part land, then hand over what there is.
        try await Task.sleep(nanoseconds: 1_500_000_000)
        let latest = (try? await replies(in: conversationId, since: sentAt)) ?? found
        return (conversationId, Self.text(of: latest.isEmpty ? found : latest))
    }

    private func replies(in conversationId: String, since sentAt: Date) async throws -> [Item] {
        let page = try await api.page("/v1/conversations/\(conversationId)/items?order=desc&limit=10", as: Item.self)
        return page.items.filter { $0.type == "agent_message" && ($0.at ?? .distantPast) >= sentAt && !($0.markdown ?? "").isEmpty }
    }

    private static func text(of replies: [Item]) -> String {
        replies.sorted { ($0.at ?? .distantPast) < ($1.at ?? .distantPast) }.compactMap(\.markdown).joined(separator: "\n\n")
    }
}
