import Foundation
import SwiftUI
import UIKit

/// One agent's decided requests, newest first (GET /v1/requests?agentId=&status=resolved, cursor-paged).
struct DecidedRequests {
    var items: [AgentRequest] = []
    var next: String?
    var loading = false
}

/// Tasks, take-over tap targets, secure input and the Permissions tab's data.
extension World {
    // MARK: Tasks (GET /v1/agents/:id/tasks, task.updated, POST /v1/tasks/:id/stop)

    /// The live tasks whole plus the newest ended page; `taskNext` holds where the next ended page starts.
    func loadTasks(_ agentId: String) {
        guard let api else { return }
        Task { @MainActor in
            if let page = try? await api.page("/v1/agents/\(agentId)/tasks", as: Contract.AgentTask.self) {
                self.tasks[agentId] = page.items
                self.taskNext[agentId] = page.next
            }
        }
    }

    /// The next page of older ended tasks (GET /v1/tasks?status=ended&cursor=), appended after the ones already shown.
    func loadMoreTasks(_ agentId: String) {
        guard let api, let cursor = taskNext[agentId] else { return }
        taskNext[agentId] = nil
        Task { @MainActor in
            guard let page = try? await api.page("/v1/tasks?agentId=\(agentId)&status=ended&cursor=\(cursor)", as: Contract.AgentTask.self) else {
                self.taskNext[agentId] = cursor
                return
            }
            let known = Set((self.tasks[agentId] ?? []).map(\.id))
            self.tasks[agentId, default: []] += page.items.filter { !known.contains($0.id) }
            self.taskNext[agentId] = page.next
        }
    }

    /// The agent's tasks (GET /v1/agents/:id/tasks, kept live by `task.updated`).
    func taskList(_ agentId: String) -> [Contract.AgentTask] { tasks[agentId] ?? [] }

    func stopTask(_ task: Contract.AgentTask) {
        guard let agentId = task.agentId else { return }
        if let i = tasks[agentId]?.firstIndex(where: { $0.id == task.id }) {
            tasks[agentId]?[i].status = "ended"; tasks[agentId]?[i].outcome = "cancelled"; tasks[agentId]?[i].outcomeDetail = "stopped_by_owner"
        }
        remote { try await $0.post("/v1/tasks/\(task.id)/stop") }
    }

    func applyTask(_ task: Contract.AgentTask?) {
        guard let task, let agentId = task.agentId else { return }
        var list = tasks[agentId] ?? []
        if let i = list.firstIndex(where: { $0.id == task.id }) { list[i] = task } else { list.insert(task, at: 0) }
        tasks[agentId] = list
    }

    // MARK: Take-over: tap targets

    /// GET /v1/screens/:id/elements. Only answers while the user controls the screen (409 otherwise): call it after taking over.
    func loadElements(_ agentId: String) async {
        guard let api, let screen = await screenId(for: agentId) else { return }
        if let found = try? await api.get("/v1/screens/\(screen)/elements", as: Contract.ScreenElements.self) {
            screenElements[agentId] = found
        }
    }

    /// What the computer's clipboard holds after the user's Ctrl+C (GET /v1/screens/:id/clipboard). Only while the user controls the screen (409 otherwise).
    func copyComputerClipboard(_ agentId: String) async throws -> Contract.ScreenClipboard {
        guard let api, let screen = await screenId(for: agentId) else { throw APIError.notSignedIn }
        return try await api.get("/v1/screens/\(screen)/clipboard", as: Contract.ScreenClipboard.self)
    }

    /// Puts an image or files on the computer (POST /v1/screens/:id/clipboard); the caller then sends Ctrl+V for an image.
    func pasteComputerClipboard(_ agentId: String, _ input: Contract.ScreenClipboardPaste) async throws -> Contract.ScreenClipboardPasteResult {
        guard let api, let screen = await screenId(for: agentId) else { throw APIError.notSignedIn }
        return try await api.post("/v1/screens/\(screen)/clipboard", input, as: Contract.ScreenClipboardPasteResult.self)
    }

    /// "Done" in a take-over: hand the screen back; the server approves the agent's pending computer request.
    func returnControl(_ request: AgentRequest) {
        if let i = requests.firstIndex(where: { $0.id == request.id }), requests[i].status == "pending" {
            requests[i].status = "approved"; requests[i].resolvedAt = Date()
        }
        if let agentId = request.agentId { setController("agent", agentId: agentId) }
    }

    // MARK: Answering a question

    /// Sends the answers of a `question` request and waits for the server, so the sheet can show per-field errors
    /// (`APIError.fields`) and stay open. The card flips to answered only after the server accepted them.
    func answerQuestion(_ requestId: String, answers: [String: String]) async throws {
        if let api {
            struct Body: Encodable { var action = "answer"; var answers: [String: String] }
            _ = try await api.post("/v1/requests/\(requestId)/resolve", Body(answers: answers))
        }
        if let i = requests.firstIndex(where: { $0.id == requestId }) {
            // Edit a copy and write it back once: reading `requests` inside its own write is an exclusivity
            // violation (a crash, not a warning).
            var request = requests[i]
            request.status = "answered"; request.resolvedAt = Date()
            request.payload?.answers = answers
            requests[i] = request
        }
    }

    // MARK: Secure input (POST /v1/requests/:id/secure-input)

    /// Encrypts every value to the request's `encryption` key (see `SecureSeal`) before anything leaves the phone.
    /// Throws `SecureSeal.Failure.olderComputer` when the request has no usable key.
    func sealSecureInput(_ requestId: String, values: [String: String]) throws -> [String: Contract.SealedSecureValue] {
        let payload = request(requestId)?.payload
        var sealed: [String: Contract.SealedSecureValue] = [:]
        for field in payload?.fields ?? [] {
            guard let value = values[field.id], !value.isEmpty else { continue }
            sealed[field.id] = try SecureSeal.seal(value, encryption: payload?.encryption, requestId: requestId, fieldId: field.id, ref: field.ref)
        }
        return sealed
    }

    /// Sends the sealed values to the page through the server. Throws `APIError.api(409, "USER_CONTROL")` while the user
    /// holds the screen, and `409 ENCRYPTION_UNAVAILABLE` for a request from an older computer.
    @discardableResult
    func submitSecureInput(_ requestId: String, sealed: [String: Contract.SealedSecureValue]) async throws -> [Contract.SecureInputResult.Field] {
        guard let api else {
            if let i = requests.firstIndex(where: { $0.id == requestId }) { requests[i].status = "approved"; requests[i].resolvedAt = Date() }
            return []
        }
        let data = try await api.post("/v1/requests/\(requestId)/secure-input", Contract.SubmitSecureInput(fields: sealed))
        let result = try isoDecoder.decode(Contract.SecureInputResult.self, from: data)
        if let fresh = try? await api.get("/v1/requests/\(requestId)", as: AgentRequest.self),
           let i = requests.firstIndex(where: { $0.id == requestId }) { requests[i] = fresh }
        return result.fields ?? []
    }

    /// Tell the server which vault details exist (names only; the values stay in this phone's Keychain).
    func syncVaultKeys() {
        guard let api else { return }
        let entries = SecureVault.entries().map { Contract.SecureVaultEntry(id: $0.id, label: $0.label, kind: $0.kind) }
        Task { _ = try? await api.put("/v1/secure-vault/keys", Contract.SecureVaultKeys(entries: entries)) }
    }

    /// Cancel a secure-input request (the server only accepts a deny for this kind).
    func cancelSecureInput(_ requestId: String) { resolve(requestId, decision: "denied") }

    // MARK: Previews

    /// The screenshot an approval carries (a library image), cached.
    func previewImage(_ libraryId: String) async -> UIImage? {
        if let image = previewImages[libraryId] { return image }
        // The download is JSON `{name, mimeType, contentBase64}`, not raw bytes (as in `downloadFile`).
        struct Download: Decodable { var contentBase64: String }
        guard let api, let file = try? await api.get("/v1/library/\(libraryId)/download", as: Download.self),
              let data = Data(base64Encoded: file.contentBase64), let image = UIImage(data: data) else { return nil }
        previewImages[libraryId] = image
        return image
    }

    /// A server-relative URL (a signed icon) made absolute against the signed-in server.
    func absoluteURL(_ path: String?) -> URL? {
        path.flatMap { URL(string: $0, relativeTo: api?.session.server)?.absoluteURL }
    }

    /// The server's brand picture (PNG) for a connector catalog id or channel kind.
    func brandIconURL(_ id: String) -> URL? { absoluteURL("/v1/brand-icons/\(id).png") }

    // MARK: Permissions tab

    func loadDecided(_ agentId: String, more: Bool = false) {
        guard api != nil else { return }
        var state = decided[agentId] ?? DecidedRequests()
        guard !state.loading, !more || state.next != nil else { return }
        state.loading = true
        decided[agentId] = state
        let cursor = more ? state.next : nil
        Task { @MainActor in
            guard let api else { return }
            var current = self.decided[agentId] ?? DecidedRequests()
            var next = cursor
            if !more { current.items = [] }
            // A page can hold fewer rows than asked (pending ones are skipped): follow the cursor until something shows.
            for _ in 0..<6 {
                let path = "/v1/requests?agentId=\(agentId)&status=resolved&limit=15" + (next.map { "&cursor=\($0)" } ?? "")
                guard let page = try? await api.page(path, as: AgentRequest.self) else { break }
                current.items += page.items
                current.next = page.next
                next = page.next
                if !page.items.isEmpty || next == nil { break }
            }
            current.loading = false
            self.decided[agentId] = current
        }
    }

    /// The agent's decided requests (paged list).
    func history(_ agentId: String) -> [AgentRequest] { decided[agentId]?.items ?? [] }

    func loadGrants(_ agentId: String) {
        guard let api else { return }
        Task { @MainActor in
            if let list = try? await api.list("/v1/rules?agentId=\(agentId)&limit=100", as: Rule.self) { self.grants[agentId] = list }
        }
    }

    /// Older per-tool "allowed without asking" rules (never the built-in policy rules, never delegations).
    func standingGrants(_ agentId: String) -> [Rule] {
        let list = grants[agentId] ?? []
        return list.filter { $0.behavior == "auto" && $0.source != "builtin" && $0.scope != "delegation" }
    }

    // MARK: Delegations (GET/POST/PATCH/DELETE /v1/delegations)

    func loadDelegations(_ agentId: String) {
        guard let api else { return }
        Task { @MainActor in
            if let list = try? await api.list("/v1/delegations?agentId=\(agentId)&limit=100", as: Rule.self) { self.delegationRules[agentId] = list }
        }
    }

    /// What this agent may decide alone: enabled delegations, newest first.
    func delegations(_ agentId: String) -> [Rule] {
        (delegationRules[agentId] ?? []).filter { $0.enabled != false }
    }

    /// A chat in a decision (`ChatName`): the title the server sent, else the conversation's own title looked up by id, else "a chat".
    func chatName(_ id: String?, _ title: String?) -> String {
        let sent = title?.trimmingCharacters(in: .whitespaces) ?? ""
        return ChatWords.label(sent.isEmpty ? conversation(id)?.title : sent)
    }

    /// Changes a delegation's limits; the server rewrites its description, so the list is reloaded afterwards.
    func updateDelegation(_ rule: Rule, limits: Contract.DelegationLimits, agentId: String) {
        if let i = delegationRules[agentId]?.firstIndex(where: { $0.id == rule.id }) { delegationRules[agentId]?[i].delegation?.limits = limits }
        remote {
            try await $0.patch("/v1/delegations/\(rule.id)", Contract.UpdateDelegationInput(limits: limits))
            self.loadDelegations(agentId)
        }
    }

    func revokeDelegation(_ rule: Rule, agentId: String) {
        delegationRules[agentId]?.removeAll { $0.id == rule.id }
        remote { try await $0.delete("/v1/delegations/\(rule.id)") }
    }

    func revoke(_ rule: Rule, agentId: String) {
        grants[agentId]?.removeAll { $0.id == rule.id }
        rules.removeAll { $0.id == rule.id }
        remote { try await $0.delete("/v1/rules/\(rule.id)") }
    }

    /// PATCH /v1/agents/:id {permissionTiers}: only the changed tier is sent.
    func setTier(_ agentId: String, _ change: (inout Contract.PermissionTiers) -> Void) {
        guard let i = agents.firstIndex(where: { $0.id == agentId }) else { return }
        var tiers = agents[i].permissionTiers ?? Contract.PermissionTiers()
        let before = tiers
        change(&tiers)
        agents[i].permissionTiers = tiers
        var patch = Contract.PermissionTiers()
        change(&patch)
        guard tiers != before else { return }
        struct Body: Encodable { var permissionTiers: Contract.PermissionTiers }
        remote { try await $0.patch("/v1/agents/\(agentId)", Body(permissionTiers: patch)) }
    }
}
