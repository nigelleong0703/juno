import Foundation
import SwiftUI
import UIKit

extension World {
    /// Run lists don't carry steps on the live API; fetch them once when a run is shown.
    func loadSteps(_ runId: String) {
        guard let api, !stepsLoaded.contains(runId) else { return }
        stepsLoaded.insert(runId)
        Task { @MainActor in
            guard let steps = try? await api.list("/v1/runs/\(runId)/steps?limit=200", as: Step.self) else { return }
            func merged(_ run: Run) -> [Step] {
                var all = run.steps ?? []
                for s in steps {
                    if let k = all.firstIndex(where: { $0.id == s.id }) { all[k] = s } else { all.append(s) }
                }
                return all.sorted { ($0.index ?? 0) < ($1.index ?? 0) }
            }
            if let i = self.runs.firstIndex(where: { $0.id == runId }) { self.runs[i].steps = merged(self.runs[i]) }
            else if let child = self.childRuns[runId] { self.childRuns[runId]?.steps = merged(child) }
        }
    }

    /// The helper runs a task spawned, newest last. The run list leaves helpers out, so the ones the parent names are
    /// fetched by id when its detail opens; live events keep them current after that.
    func children(of runId: String) -> [Run] {
        childRuns.values.filter { $0.parentRunId == runId }.sorted { ($0.startedAt ?? .distantPast) < ($1.startedAt ?? .distantPast) }
    }

    func loadChildren(of runId: String) async {
        guard let api else { return }
        let ids = (run(runId)?.childRunIds ?? []).filter { childRuns[$0] == nil }
        if !ids.isEmpty, let found = try? await api.list("/v1/runs?ids=\(ids.joined(separator: ","))", as: Run.self) {
            for child in found where child.parentRunId != nil { childRuns[child.id] = childRuns[child.id].map { var c = child; c.steps = $0.steps; return c } ?? child }
        }
        for child in children(of: runId) { loadSteps(child.id) }
    }

    func loadPlans(_ agentId: String) {
        guard let api else { return }
        Task { @MainActor in
            if let list = try? await api.list("/v1/agents/\(agentId)/plans?limit=100", as: Item.self) {
                self.planItems[agentId] = list
            }
        }
    }

    /// Todo plans for an agent: from /plans.
    func agentPlans(_ agentId: String) -> [Item] {
        planItems[agentId] ?? []
    }

    /// A signed websocket URL for the live screen (POST /v1/screens/:id/stream). The issued host is advisory —
    /// agentd reports its loopback address — so the route is pinned to the server we're signed in to
    /// (same rule as packages/client normalizeScreenStreamTicket).
    func streamURL(_ agentId: String, control: Bool) async -> URL? {
        guard let api, let session, let screen = await screenId(for: agentId) else { return nil }
        struct Body: Encodable { var control: Bool }
        struct Ticket: Decodable { var url: String; var control: Bool? }
        guard let data = try? await api.post("/v1/screens/\(screen)/stream", Body(control: control)),
              let ticket = try? JSONDecoder().decode(Ticket.self, from: data),
              // A control ticket is writable only if the server already has the user in control; otherwise it is a
              // view-only stream that looks fine and silently drops every click. Not usable: the caller retries.
              !control || ticket.control == true,
              let issued = URLComponents(string: ticket.url),
              issued.path == "/v1/screens/\(screen)/vnc",
              var out = URLComponents(url: session.server, resolvingAgainstBaseURL: false) else { return nil }
        out.scheme = session.server.scheme == "https" ? "wss" : "ws"
        out.path = issued.path
        out.percentEncodedQuery = issued.percentEncodedQuery
        return out.url
    }

    /// One screenshot of the agent's screen, if it has a computer and a display.
    func refreshScreen(_ agentId: String) async {
        guard let api, let screen = await screenId(for: agentId) else { return }
        struct Shot: Decodable { var data: String }
        if let shot = try? await api.get("/v1/screens/\(screen)/screenshot", as: Shot.self),
           let data = Data(base64Encoded: shot.data), let image = UIImage(data: data) {
            screenshots[agentId] = image
        }
    }

    /// decision: approved / denied / answered (UI words) → action approve / deny / answer (API). An approval is `once`
    /// or `delegate` (with the edited `delegations`); a denial with `reason: "revise"` and a note sends the request back.
    func resolve(_ requestId: String, decision: String, answers: [String: String]? = nil, note: String? = nil,
                 editedDraft: String? = nil, scope: String = "once", delegations: [Contract.DelegationDraft]? = nil, reason: String? = nil) {
        guard let index = requests.firstIndex(where: { $0.id == requestId }) else { return }
        let agentId = requests[index].agentId
        // Until the server's `request.resolved` arrives: approved → allowed once, denied/revised as sent.
        requests[index].status = decision
        requests[index].resolvedAt = Date()
        requests[index].outcome = decision == "approved" ? "allowed_once" : decision == "denied" ? (reason == "revise" ? "revised" : "denied") : nil
        let action = decision == "approved" ? "approve" : decision == "answered" ? "answer" : "deny"
        let body = Contract.ResolveRequestInput(action: action, scope: action == "approve" ? scope : nil,
                                                delegations: scope == "delegate" ? delegations : nil, reason: reason, answers: answers,
                                                editedDraft: editedDraft, note: note?.isEmpty == true ? nil : note)
        let request = requests[index]
        let siblings = requests.filter {
            $0.status == "pending" && request.runId != nil && $0.runId == request.runId && $0.conversationId == request.conversationId
        }
        // A standard resume batch must answer every request of one interrupted segment. The card UI handles one
        // decision at a time and this card is already marked decided, so `siblings` holds only the OTHER pending
        // cards: the standard entry is used only when none remain. Otherwise the retained product decision route
        // is used so one answer cannot half-resolve the segment.
        guard let conversationId = request.conversationId, request.runId != nil, siblings.isEmpty else {
            remote {
                do {
                    try await $0.post("/v1/requests/\(requestId)/resolve", body)
                    if scope == "delegate", let agentId { self.loadDelegations(agentId) }
                } catch let error where Self.isExpiredApproval(error) {
                    self.markExpired(requestId)
                }
            }
            return
        }
        let entry = Contract.ResumeEntry(
            interruptId: requestId, status: decision == "denied" ? "cancelled" : "resolved", payload: encodedJSONValue(body))
        let input = Contract.RunAgentInput(threadId: conversationId, runId: request.runId, messages: [], resume: [entry])
        guard let api else { return }
        Task { @MainActor in
            do {
                _ = try await api.post("/v1/conversations/\(conversationId)/runs", input)
                if scope == "delegate", let agentId { self.loadDelegations(agentId) }
            } catch where Self.isExpiredApproval(error) {
                self.markExpired(requestId)
            } catch where !error.isCancellation {
                if self.api?.session == api.session, let i = self.requests.firstIndex(where: { $0.id == requestId }),
                   self.requests[i].status == decision {
                    self.requests[i].status = "pending"
                    self.requests[i].resolvedAt = nil
                    self.requests[i].outcome = nil
                }
                self.syncError = error.localizedDescription
            } catch {}
        }
    }

    /// The server refused an Allow because the 24-hour approval window passed (409 `REQUEST_EXPIRED`).
    nonisolated static func isExpiredApproval(_ error: Error) -> Bool {
        if case APIError.api(409, "REQUEST_EXPIRED", _) = error { return true }
        return false
    }

    /// The card reads "Expired" at once (the server closes it as timed out), and the requests are read again to settle it.
    @MainActor
    func markExpired(_ requestId: String) {
        if let i = requests.firstIndex(where: { $0.id == requestId }) {
            requests[i].status = "expired"
            requests[i].outcome = "timed_out"
            requests[i].resolvedAt = requests[i].resolvedAt ?? Date()
        }
        Task { await refreshRequests() }
    }

    /// Creates a conversation and only inserts the server result after the signed-in session is still current.
    func createConversation(kind: String, memberAgentIds: [String], title: String?, requestId: String) async throws -> Conversation {
        if kind == "direct", let agentId = memberAgentIds.first,
           let existing = directConversation(for: agentId) { return existing }

        guard let api else {
            throw APIError.http(401, "Sign in to create a conversation.")
        }

        struct Body: Encodable {
            var kind: String
            var memberAgentIds: [String]
            var title: String?
            var roomMode: String?
            var requestId: String
        }
        let request = Body(kind: kind, memberAgentIds: memberAgentIds, title: title,
                           roomMode: kind == "room" ? "mention" : nil, requestId: requestId)
        let response = try await api.post("/v1/conversations", request)
        struct Envelope: Decodable { var conversation: Conversation }
        let conversation = try (try? isoDecoder.decode(Conversation.self, from: response))
            ?? isoDecoder.decode(Envelope.self, from: response).conversation
        guard self.api?.session == api.session else { throw CancellationError() }
        if !conversations.contains(where: { $0.id == conversation.id }) { conversations.insert(conversation, at: 0) }
        return conversation
    }

    /// A new agent and its direct chat, reusing the welcome chat created by server onboarding.
    /// An empty role is fine: the server suggests one after the first few messages (BACKEND §10.11).
    @discardableResult
    func createAgent(name: String, role: String, avatar: Avatar = Avatar(), openChat: Bool = true) async throws -> String {
        let role = role.trimmingCharacters(in: .whitespaces)
        var avatar = avatar
        // Keep the required legacy avatar fields populated alongside the selected character.
        avatar.shape = avatar.shape ?? "circle"
        avatar.color = avatar.color ?? 1
        avatar.eyes = avatar.eyes ?? "dot"
        guard let api else {
            throw APIError.http(401, "Sign in to create an agent.")
        }
        struct AgentBody: Encodable { var name: String; var title: String?; var avatar: Avatar }
        let rawAgent = try await api.post("/v1/agents", AgentBody(name: name, title: role.isEmpty ? nil : role, avatar: avatar))
        guard self.api?.session == api.session else { throw CancellationError() }
        struct AgentEnvelope: Decodable { var agent: Agent }
        let agent = try (try? isoDecoder.decode(Agent.self, from: rawAgent)) ?? isoDecoder.decode(AgentEnvelope.self, from: rawAgent).agent
        var query = URLComponents()
        query.path = "/v1/conversations"
        query.queryItems = [URLQueryItem(name: "agentId", value: agent.id), URLQueryItem(name: "kind", value: "direct")]
        guard let path = query.string else { throw APIError.badServer }
        let chats = try await api.list(path, as: Conversation.self)
        guard self.api?.session == api.session else { throw CancellationError() }
        let chat: Conversation
        if let welcome = chats.first(where: {
            $0.kind == "direct" && $0.agentIds == [agent.id] && $0.memberIds == [api.session.userId] && !$0.isChannelChat
        }) {
            chat = welcome
        } else {
            struct ChatBody: Encodable { var kind = "direct"; var memberAgentIds: [String]; var requestId: String }
            let rawChat = try await api.post("/v1/conversations", ChatBody(memberAgentIds: [agent.id], requestId: "agent-setup-" + agent.id))
            guard self.api?.session == api.session else { throw CancellationError() }
            struct ChatEnvelope: Decodable { var conversation: Conversation }
            chat = try (try? isoDecoder.decode(Conversation.self, from: rawChat)) ?? isoDecoder.decode(ChatEnvelope.self, from: rawChat).conversation
        }
        if !agents.contains(where: { $0.id == agent.id }) { agents.append(agent) }
        if !conversations.contains(where: { $0.id == chat.id }) { conversations.insert(chat, at: 0) }
        if openChat { self.openChat(chat.id) }
        return chat.id
    }

    func stopRun(_ runId: String) {
        if let i = runs.firstIndex(where: { $0.id == runId }) {
            runs[i].status = "stopped"
            runs[i].finishedAt = Date()
        }
        remote { try await $0.post("/v1/runs/\(runId)/stop") }
    }

    /// Take over the agent's screen and wait until the server has it (unlike `setController`, which is fire-and-forget): a control
    /// stream ticket asked for before this lands is issued view-only. Returns whether the screen is the person's now; a take-over
    /// that saw an old epoch (the agent or another device moved control meanwhile) leaves the screen as it is and returns false.
    @discardableResult
    func takeOver(_ agentId: String) async -> Bool {
        guard let api, let screen = await screenId(for: agentId) else { return false }
        let before = computers.first?.controller
        if !computers.isEmpty { computers[0].controller = "user" }
        do {
            let row = try await api.postControl("/v1/screens/\(screen)/take-over", expectEpoch: controlEpochs[screen])
            noteEpoch(of: row)
            if !computers.isEmpty, let holder = row.controller { computers[0].controller = holder }
            return row.controller == "user"
        } catch {
            if !computers.isEmpty { computers[0].controller = before }
            return false
        }
    }

    /// The computer pane's Start action (web ComputerPane `requestScreen`): no computer → POST /v1/computers/ensure,
    /// otherwise allocate this agent's display on it. Refreshes the computers list and the cached screen id so the
    /// view dials the live screen. Returns the server's message on failure, nil on success.
    func startComputer(for agentId: String) async -> String? {
        guard let api else { return nil }
        struct Body: Encodable { var agentId: String }
        do {
            if let computer {
                try await api.post("/v1/computers/\(computer.id)/screens", Body(agentId: agentId))
            } else {
                try await api.post("/v1/computers/ensure", Body(agentId: agentId))
            }
            forgetScreen(agentId)
            if let fresh = try? await api.list("/v1/computers", as: Computer.self) { computers = fresh }
            await refreshScreen(agentId)
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// Take over or hand back one agent's screen. The pane flips at once; the server's answer (its row, with the new epoch) settles it,
    /// and a tap that saw an old epoch changes nothing there.
    func setController(_ controller: String, agentId: String?) {
        guard !computers.isEmpty, let agentId else { return }
        computers[0].controller = controller
        let action = controller == "user" ? "take-over" : "return-control"
        remote { api in
            guard let screen = await self.screenId(for: agentId) else { return }
            let row = try await api.postControl("/v1/screens/\(screen)/\(action)", expectEpoch: self.controlEpochs[screen])
            self.noteEpoch(of: row)
            if !self.computers.isEmpty, let holder = row.controller { self.computers[0].controller = holder }
        }
    }


    /// POST /v1/proactive/feedback for an idea: the card leaves at once. "Not now" says it won't come back for two weeks;
    /// "less" and "never" make a rule, shown with Undo (which deletes it).
    func ideaFeedback(_ id: String, _ action: String, scope: String? = nil) {
        ideas.removeAll { $0.id == id }
        if action == "not_now" { showProactiveToast("Won't suggest this for two weeks", ruleId: nil) }
        struct Target: Encodable { var kind = "idea"; var id: String }
        struct Body: Encodable { var target: Target; var action: String; var scope: String? }
        struct Reply: Decodable { var rule: ProactiveRule? }
        remote { api in
            let reply = try? JSONDecoder().decode(Reply.self, from: await api.post("/v1/proactive/feedback", Body(target: Target(id: id), action: action, scope: scope)))
            if action != "not_now", let rule = reply?.rule { self.showProactiveToast(rule.text, ruleId: rule.id) }
        }
    }

    private func showProactiveToast(_ text: String, ruleId: String?) {
        let toast = ProactiveToast(text: text, ruleId: ruleId)
        proactiveToast = toast
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(6))
            if proactiveToast?.id == toast.id { proactiveToast = nil }
        }
    }

    func undoProactiveRule() {
        guard let toast = proactiveToast else { return }
        proactiveToast = nil
        guard let ruleId = toast.ruleId else { return }
        remote { try await $0.delete("/v1/proactive/rules/\(ruleId)") }
    }

    /// "Do it": the server starts the idea's agent in a new conversation; the idea leaves the list and that conversation opens.
    /// A failed accept leaves the idea where it is so the user can try again.
    func acceptIdea(_ idea: PlannedIdea) {
        guard api != nil else {
            openChat(directConversation(for: idea.agentId ?? "")?.id, draft: idea.prompt)
            return
        }
        remote { api in
            let started = try isoDecoder.decode(PlannedIdea.self, from: await api.post("/v1/ideas/\(idea.id)/accept"))
            self.ideas.removeAll { $0.id == idea.id }
            guard let conversationId = started.conversationId else { return }
            if !self.conversations.contains(where: { $0.id == conversationId }) {
                self.conversations.insert(try await api.get("/v1/conversations/\(conversationId)", as: Conversation.self), at: 0)
            }
            self.openChat(conversationId)
        }
    }

    /// The text of a draft an idea prepared (a file in the user's home); nil when it is gone or unreachable.
    func ideaDraft(_ path: String) async -> String? {
        try? await api?.homeFiles(prefix: path).first { $0.path == path }?.content
    }

    /// Use the suggested role (POST …/role-suggestion/accept), with the title as the user edited it.
    func acceptRole(_ agentId: String, title: String) {
        guard let i = agents.firstIndex(where: { $0.id == agentId }), let suggestion = agents[i].roleSuggestion else { return }
        let edited = title.trimmingCharacters(in: .whitespacesAndNewlines)
        agents[i].title = edited.isEmpty ? suggestion.title : edited
        agents[i].roleSuggestion = nil
        remote { api in
            try await api.post("/v1/agents/\(agentId)/role-suggestion/accept")
            // The server takes the suggested title; an edited one follows as a normal profile change.
            guard !edited.isEmpty, edited != suggestion.title else { return }
            struct Patch: Encodable { var title: String }
            try await api.patch("/v1/agents/\(agentId)", Patch(title: edited))
        }
    }

    /// "Not now": the server forgets the suggestion and won't suggest again for this agent.
    func dismissRole(_ agentId: String) {
        guard let i = agents.firstIndex(where: { $0.id == agentId }) else { return }
        agents[i].roleSuggestion = nil
        agents[i].roleSuggestionDismissedAt = Date()
        remote { try await $0.post("/v1/agents/\(agentId)/role-suggestion/dismiss") }
    }

    /// Pause or resume the agent (F-09). The server answers with the agent; its `pausedAt` drives the button, not `status`.
    func setAgentPaused(_ agentId: String, _ paused: Bool) {
        guard let api else { return }
        Task { @MainActor in
            do {
                let data = try await api.post("/v1/agents/\(agentId)/\(paused ? "pause" : "resume")")
                let updated = try isoDecoder.decode(Agent.self, from: data)
                if let i = agents.firstIndex(where: { $0.id == agentId }) { agents[i] = updated }
            } catch where !error.isCancellation {
                syncError = error.localizedDescription
            } catch {}
        }
    }

    /// Stop every active run of the agent, child runs included (F-09).
    func stopAgent(_ agentId: String) {
        remote { try await $0.post("/v1/agents/\(agentId)/stop") }
    }

    /// Saves all profile fields edited in the agent card, including its avatar.
    func saveAgent(_ id: String) {
        guard let agent = agent(id) else { return }
        remote { try await $0.patch("/v1/agents/\(id)", AgentProfilePayload(agent: agent)) }
    }

    /// The identity editor commits only after the server accepts its draft.
    func saveAgentProfile(_ draft: Agent) async throws {
        guard agent(draft.id) != nil else { throw APIError.http(404, "This agent is no longer available.") }
        var saved = draft
        saved.name = draft.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let name = saved.name, !name.isEmpty else { throw APIError.http(400, "Enter an agent name.") }
        var avatar = saved.avatar ?? Avatar()
        // Required legacy fields remain in the public avatar contract even though only characters render.
        avatar.shape = avatar.shape ?? "circle"
        avatar.color = avatar.color ?? 1
        avatar.eyes = avatar.eyes ?? "dot"
        saved.avatar = avatar
        if let api {
            try await api.patch("/v1/agents/\(saved.id)", AgentProfilePayload(agent: saved))
            guard self.api?.session == api.session else { throw CancellationError() }
        }
        guard let i = agents.firstIndex(where: { $0.id == saved.id }) else { throw APIError.http(404, "This agent is no longer available.") }
        agents[i].name = saved.name
        agents[i].title = saved.title
        agents[i].avatar = saved.avatar
    }

    // MARK: Feed, goals, schedules, audit (Muse tabs)

    /// "Reply" on a post: the agent's direct chat opens with the post as the quoted message (the chat's own reply chip)
    /// and the composer focused. Nothing is sent. False when the agent has no direct chat.
    @discardableResult
    func replyToPost(_ post: FeedPost) -> Bool {
        guard let conversation = directConversation(for: post.agentId ?? "") else { return false }
        noteInterest(post)
        let text = [post.title, post.cardSummary].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n")
        replyTo[conversation.id] = Item(id: "feed-\(post.id)", conversationId: conversation.id, at: post.createdAt, type: "agent_message",
                                        agentId: post.agentId, markdown: text)
        // An empty draft still focuses the composer (it takes any saved draft and raises the keyboard).
        openChat(conversation.id, draft: "")
        return true
    }

    /// "Forward…": the post as a message in any chat: title, summary and the source link.
    func forwardPost(_ post: FeedPost, to conversationId: String) {
        let text = [post.title.map { "**\($0)**" }, post.cardSummary, post.sourceUrl].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n\n")
        noteInterest(post)
        send(text, in: conversationId)
    }

    /// POST /v1/goals. The goal appears at once; the server's copy replaces it (the id changes).
    func createGoal(agentId: String, kind: String, title: String, summary: String, category: String) {
        let localId = "local-" + UUID().uuidString
        let now = Date()
        goals.insert(PlannedGoal(id: localId, status: "active", agentId: agentId, kind: kind, title: title, summary: summary,
                                 category: category, activity: [GoalActivity(at: now, actor: "user", kind: "created", text: "Created the goal")]), at: 0)
        guard api != nil else { return }
        askForNotifications()
        struct Body: Encodable { var agentId, kind, title, summary, category: String }
        remote { api in
            let data = try await api.post("/v1/goals", Body(agentId: agentId, kind: kind, title: title, summary: summary, category: category))
            struct Envelope: Decodable { var goal: PlannedGoal }
            guard let goal = (try? isoDecoder.decode(PlannedGoal.self, from: data)) ?? (try? isoDecoder.decode(Envelope.self, from: data))?.goal else { return }
            self.goals.removeAll { $0.id == localId || $0.id == goal.id }
            self.goals.insert(goal, at: 0)
        }
    }

    /// GET /v1/goals/:id: the full goal with its activity timeline (the envelope is accepted too).
    func loadGoal(_ goalId: String) {
        guard let api else { return }
        struct Envelope: Decodable { var goal: PlannedGoal }
        Task { @MainActor in
            var goal: PlannedGoal? = try? await api.get("/v1/goals/\(goalId)", as: PlannedGoal.self)
            if goal == nil { goal = (try? await api.get("/v1/goals/\(goalId)", as: Envelope.self))?.goal }
            guard let goal, let i = self.goals.firstIndex(where: { $0.id == goalId }) else { return }
            self.goals[i] = goal
        }
    }

    /// PATCH /v1/goals/:id {status}: pause or resume. The row flips at once; the server's copy follows over the live events.
    func setGoalStatus(_ goalId: String, _ status: String) {
        guard let i = goals.firstIndex(where: { $0.id == goalId }) else { return }
        goals[i].status = status
        struct Body: Encodable { var status: String }
        remote { try await $0.patch("/v1/goals/\(goalId)", Body(status: status)) }
    }

    /// POST /v1/goals/:id/check ("Check now"): the goal's agent does a check-in outside its schedule.
    func checkGoal(_ goalId: String) {
        remote { try await $0.post("/v1/goals/\(goalId)/check") }
    }

    /// POST /v1/routines/:id/toggle (the schedule switch).
    func toggleRoutine(_ routineId: String) {
        guard let i = routines.firstIndex(where: { $0.id == routineId }) else { return }
        routines[i].enabled = !(routines[i].enabled ?? false)
        if routines[i].enabled == true { askForNotifications() }
        remote { try await $0.post("/v1/routines/\(routineId)/toggle") }
    }

    /// Deletes a routine.
    func deleteRoutine(_ routineId: String) {
        routines.removeAll { $0.id == routineId }
        remote { try await $0.delete("/v1/routines/\(routineId)") }
    }
}

/// Projects the existing Agent onto its writable profile fields (the persona texts live in home files, not here).
private struct AgentProfilePayload: Encodable {
    var agent: Agent
    enum CodingKeys: String, CodingKey { case name, title, avatar }
    func encode(to encoder: Encoder) throws {
        var out = encoder.container(keyedBy: CodingKeys.self)
        try out.encodeIfPresent(agent.name, forKey: .name)
        try out.encodeIfPresent(agent.title, forKey: .title)
        try out.encodeIfPresent(agent.avatar, forKey: .avatar)
    }
}

extension World {
    /// GET /v1/home?path=<prefix>. Without a server (demo data) there are no home files.
    func homeFiles(_ prefix: String) async throws -> [Contract.AgentHomeFile] {
        guard let api else { return [] }
        return try await api.homeFiles(prefix: prefix)
    }

    /// The claims behind the memory files. Without a server (demo data) there are none.
    func memoryClaims() async throws -> [Contract.MemoryClaim] {
        guard let api else { return [] }
        return try await api.memoryClaims()
    }

    func forgetMemory(_ claimIds: [String]) async throws {
        guard let api else { throw APIError.notSignedIn }
        _ = try await api.forgetMemory(claimIds: claimIds)
        homeRevision += 1
    }

    func searchMemory(_ query: String) async throws -> [Contract.MemorySearchHit] {
        guard let api else { return [] }
        return try await api.searchMemory(query)
    }

    /// PUT /v1/home/<path>; a 409 `HOME_CONFLICT` means the file changed elsewhere since `expectedHash`.
    func writeHomeFile(_ path: String, content: String, expectedHash: String?) async throws {
        guard let api else { throw APIError.notSignedIn }
        try await api.writeHomeFile(path: path, content: content, expectedHash: expectedHash)
    }
}

extension Error {
    /// The file changed elsewhere since it was loaded (PUT /v1/home → 409 `HOME_CONFLICT`).
    var isHomeConflict: Bool {
        if let failure = self as? APIError, case .api(_, let code, _) = failure { return code == "HOME_CONFLICT" }
        return false
    }
}
