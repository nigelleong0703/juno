import Foundation

/// What a tap on a Today card does (contracts 0.18): inspiration, finished runs and dismissals.
extension World {
    /// Perform the card's action. A chat opens (or starts, prefilled) the conversation with that agent; with no agent it
    /// opens the new-agent form.
    func perform(_ card: TodaySummary.Inspiration) {
        switch card.action {
        case .chat(let agentId, let text):
            guard let agentId, agent(agentId) != nil else { starterText = text; sheet = .newAgent; return }
            if let chat = directConversation(for: agentId) { openChat(chat.id, draft: text) } else { openAgentPage(agentId, from: "today-\(agentId)") }
        case .unlock(let target, let connectorId, let agentId):
            switch target {
            case "connector": pendingRoute = connectorId.map { Route.app($0) } ?? .apps
            case "profile": sheet = .settings(.details)
            default: if let id = agentId ?? agents.first?.id { openAgentPage(id, from: "today-\(id)", tab: "computer") }
            }
        }
    }

    /// "×" on a card: gone at once, and the server keeps it away.
    func dismiss(_ card: TodaySummary.Inspiration) {
        inspirationHidden.insert(card.id)
        remote { api in _ = try await api.post("/v1/inspiration/\(card.id)/dismiss") }
    }

    /// Opening a finished run's chat from Today marks it seen so it leaves the list.
    func open(_ done: TodaySummary.Completed) {
        runsSeen.insert(done.runId)
        remote { api in _ = try await api.post("/v1/runs/\(done.runId)/seen") }
        if let chat = run(done.runId)?.conversationId ?? directConversation(for: done.agentId)?.id { openChat(chat) } else { openAgentPage(done.agentId, from: "today-\(done.agentId)") }
    }
}
