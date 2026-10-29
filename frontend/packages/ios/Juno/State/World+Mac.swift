import Foundation

/// The owner's Mac as a second computer for agents ("My Mac"). The Mac itself is paired from the Juno desktop app; here an
/// agent is allowed to use it next to its sandbox (Agent.macAccess) and the Mac's state is shown, "Mac offline" included.
extension World {
    /// Reloads whether a Mac is paired and online; a failure keeps what was known.
    @MainActor
    func refreshMyMac() async {
        guard let api else { myMac = nil; return }
        if let status = try? await api.get("/v1/computers/my-mac", as: Contract.MacStatus.self) { myMac = status }
    }

    /// POST /v1/computers/my-mac/stop: stops all agent access to the Mac from here (the Mac cancels what is running). There is no
    /// Resume on the phone: only the Mac itself resumes, and `MacStatus.stopped` says it is waiting for that.
    @MainActor
    func stopMyMac() async throws {
        guard let api else { throw APIError.notSignedIn }
        myMac = try await api.post("/v1/computers/my-mac/stop", nil, as: Contract.MacStatus.self)
    }

    /// `control.changed` for the Mac: Stopped (here, on the Mac or from the Chrome extension) or resumed on the Mac. An event older
    /// than the stop already known (a replay) changes nothing.
    @MainActor
    func applyMacControl(holder: String, epoch: Int, since: Date?) {
        guard var status = myMac, epoch >= (status.stopped?.epoch ?? -1) else { return }
        status.stopped = holder == "stopped" ? Contract.MacStatus.Stopped(since: since, epoch: epoch) : nil
        myMac = status
    }

    /// Whether the agent may use the Mac.
    func canUseMac(_ agentId: String) -> Bool { agent(agentId)?.macAccess == true }

    /// PATCH /v1/agents/:id {macAccess}. The switch only turns on once a Mac is paired; if the server still refuses, it
    /// goes back and the reason shows.
    @MainActor
    func setMacAccess(_ agentId: String, _ on: Bool) {
        guard let i = agents.firstIndex(where: { $0.id == agentId }) else { return }
        let before = agents[i].macAccess
        guard before != on, let api else { return }
        agents[i].macAccess = on
        struct Body: Encodable { var macAccess: Bool }
        Task { @MainActor in
            do { try await api.patch("/v1/agents/\(agentId)", Body(macAccess: on)) } catch where !error.isCancellation {
                if let j = self.agents.firstIndex(where: { $0.id == agentId }) { self.agents[j].macAccess = before }
                self.syncError = error.localizedDescription
            } catch {}
        }
    }
}
