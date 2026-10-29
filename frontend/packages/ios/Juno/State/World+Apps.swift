import Foundation

/// Apps (contracts 0.65.0): the list and each app's detail, adding an app (sign in, a key, a bot or workspace), removing an
/// account, turning an app on per agent and an agent on per workspace. Every app request goes through here.
extension World {
    /// Where the server sends the browser after a work app's sign-in (allow-listed there as MCP_OAUTH_APP_RETURN_URLS).
    static let appReturnUrl = "juno://connectors"

    func app(_ id: String?) -> Contract.App? { apps?.first { $0.id == id } }

    /// Reloads the list; a failure keeps what was known and flags the page when there is nothing to show.
    @MainActor
    func refreshApps() async {
        guard let api else { apps = nil; return }
        do {
            apps = try await api.list("/v1/apps", as: Contract.App.self)
            appsLoadFailed = false
        } catch where !error.isCancellation {
            appsLoadFailed = apps == nil
        } catch {}
    }

    /// Reloads one app's detail and keeps its list entry in step.
    @MainActor
    func refreshApp(_ id: String) async {
        guard let api, let detail = try? await api.get("/v1/apps/\(id)", as: Contract.AppDetail.self) else { return }
        appDetails[id] = detail
        if let i = apps?.firstIndex(where: { $0.id == id }) {
            apps?[i].installations = detail.installations
            apps?[i].enabledAgents = detail.enabledAgents
        }
    }

    /// Both, after a change that can add or remove apps.
    @MainActor
    func reloadApps(_ id: String? = nil) async {
        await refreshApps()
        if let id { await refreshApp(id) }
    }

    /// POST /v1/apps/custom/probe: what an MCP server at an address asks for (how it signs in, its tools with a suggested Read or Change
    /// mark). Nothing is stored.
    @MainActor
    func probeCustomApp(_ url: String) async throws -> Contract.ProbeCustomAppResponse {
        try await signedIn().post("/v1/apps/custom/probe", Contract.ProbeCustomAppInput(url: url), as: Contract.ProbeCustomAppResponse.self)
    }

    /// POST /v1/apps/:id/install. `body` is the category's input: `InstallWorkBody`, `Contract.InstallAppChatInput` or
    /// `Contract.InstallAppCustomInput`. The reply carries what to open next.
    @MainActor
    func installApp<Body: Encodable & Sendable>(_ id: String, _ body: Body) async throws -> Contract.InstallAppResponse {
        let reply = try await signedIn().post("/v1/apps/\(id)/install", body, as: Contract.InstallAppResponse.self)
        await reloadApps(reply.appId ?? id)
        return reply
    }

    /// One account, workspace or bot; also cancels a pending install (pass `pending[].id`).
    @MainActor
    func removeInstallation(_ appId: String, _ installationId: String) async throws {
        try await signedIn().delete("/v1/apps/\(appId)/installations/\(installationId)")
        await reloadApps(appId)
    }

    /// Every account of the app.
    @MainActor
    func removeApp(_ app: Contract.App) async throws {
        for account in app.accounts { try await signedIn().delete("/v1/apps/\(app.id)/installations/\(account.id)") }
        await reloadApps(app.id)
    }

    /// PUT /v1/agents/:agentId/apps/:appId: a work or custom app on or off for one agent, with its actions policy (kept when nil).
    /// The change shows at once and is put back if the server refuses it.
    @MainActor
    func setAgentApp(_ agentId: String, _ appId: String, enabled: Bool, policy: Contract.ActionsPolicy? = nil) async throws {
        let api = try signedIn()
        applyAgentApp(agentId, appId, enabled: enabled, policy: policy)
        do {
            _ = try await api.put("/v1/agents/\(agentId)/apps/\(appId)", Contract.SetAgentAppInput(enabled: enabled, actionsPolicy: policy?.rawValue))
        } catch {
            await reloadApps(appId)
            throw error
        }
    }

    private func applyAgentApp(_ agentId: String, _ appId: String, enabled: Bool, policy: Contract.ActionsPolicy?) {
        func apply(_ list: inout [Contract.AppEnabledAgent]?) {
            var rows = list ?? []
            if let i = rows.firstIndex(where: { $0.agentId == agentId }) {
                if enabled { if let policy { rows[i].actionsPolicy = policy.rawValue } } else { rows.remove(at: i) }
            } else if enabled {
                rows.append(Contract.AppEnabledAgent(agentId: agentId, actionsPolicy: (policy ?? .ask).rawValue))
            }
            list = rows
        }
        if let i = apps?.firstIndex(where: { $0.id == appId }) { apply(&apps![i].enabledAgents) }
        if appDetails[appId] != nil { apply(&appDetails[appId]!.enabledAgents) }
    }

    /// PUT /v1/apps/:id/installations/:installationId/agents/:agentId: a chat app, one agent in one workspace. The reply is
    /// the workspace's agents.
    @MainActor
    func setWorkspaceAgent(_ appId: String, installation installationId: String, agent agentId: String, enabled: Bool) async throws {
        struct Reply: Decodable { var items: [Contract.AppWorkspaceAgent] }
        let data = try await signedIn().put("/v1/apps/\(appId)/installations/\(installationId)/agents/\(agentId)", Contract.SetWorkspaceAgentInput(enabled: enabled))
        let agents = try isoDecoder.decode(Reply.self, from: data).items
        if let a = apps?.firstIndex(where: { $0.id == appId }), let i = apps?[a].installations?.firstIndex(where: { $0.id == installationId }) {
            apps?[a].installations?[i].agents = agents
        }
        await reloadApps(appId)
    }

    /// What finished a chat install the platform was still completing.
    enum InstallWait: Equatable { case connected, failed(String?), timedOut }

    /// Waits for a chat install (a Telegram bot being created, a Slack workspace waiting for approval): reloads the app every few
    /// seconds until a new account appears, the pending install fails or expires, or about ten minutes pass.
    @MainActor
    func waitForInstall(_ appId: String, known: Set<String>) async -> InstallWait {
        for _ in 0..<200 {
            try? await Task.sleep(for: .seconds(3))
            if Task.isCancelled { return .timedOut }
            await refreshApp(appId)
            let detail = appDetails[appId]
            if (detail?.installations ?? []).contains(where: { !known.contains($0.id) }) { return .connected }
            if let failed = (detail?.pending ?? []).first(where: { $0.status == "failed" || $0.status == "expired" }) { return .failed(failed.error) }
        }
        return .timedOut
    }

    /// A new chat with the app's example prompt in its composer: with an agent that may use the app, else the first agent.
    @MainActor
    func startChat(_ text: String, preferring agentIds: [String]) {
        let candidates = agentIds.filter { agent($0) != nil } + agents.map(\.id)
        guard let agentId = candidates.first else { starterText = text; sheet = .newAgent; return }
        if let chat = directConversation(for: agentId) { openChat(chat.id, draft: text); return }
        remote { _ in
            let chat = try await self.createConversation(kind: "direct", memberAgentIds: [agentId], title: nil, requestId: UUID().uuidString)
            self.openChat(chat.id, draft: text)
        }
    }

    /// POST /v1/apps/:id/tools/review: the owner has looked at the app's new or changed tools (`needsReview`); they go back to the
    /// normal rules. Without `tools`, every unreviewed one.
    @MainActor
    func reviewAppTools(_ appId: String, tools: [String]? = nil) async throws {
        _ = try await signedIn().post("/v1/apps/\(appId)/tools/review", Contract.ReviewAppToolsInput(tools: tools))
        await refreshApp(appId)
    }

    private func signedIn() throws -> API {
        guard let api else { throw APIError.notSignedIn }
        return api
    }
}

/// POST /v1/apps/:id/install for a work app. The route refuses keys it does not know, so nil fields are left out.
struct InstallWorkBody: Encodable {
    var returnUrl: String?
    var userConfig: [String: ConfigValue]?
    var connectionId: String?
}
