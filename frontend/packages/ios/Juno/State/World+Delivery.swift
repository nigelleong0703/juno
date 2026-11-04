import Foundation

// Delivery to messaging platforms and the history of files the agent changed (BACKEND 5.7.11 and 5.2d). The screens call these;
// none of them touches the transcript's own send state (`outbox` in World is the owner's unsent messages).

extension World {
    // MARK: A reply the platform did not get

    /// Queue a dropped platform reply again: find its row (`GET /v1/outbox`, matched by the message it carries), then
    /// `POST /v1/outbox/:id/retry`. The message reads as waiting at once; the server's next `item.added` settles it.
    func retryDelivery(_ item: Item) async -> Bool {
        guard let api, let conversationId = item.conversationId else { return false }
        do {
            guard let row = try await droppedRow(for: item, in: conversationId, api: api) else { return false }
            try await api.post("/v1/outbox/\(row.id)/retry")
            guard self.api?.session == api.session else { return true }
            if let index = items[conversationId]?.firstIndex(where: { $0.id == item.id }) {
                var next = items[conversationId]![index]
                next.delivery = Contract.DeliveryState(status: Contract.OutboxStatus.pending.rawValue)
                items[conversationId]?[index] = next
                store?.upsertLive(conversationId, [next])
            }
            return true
        } catch { return false }
    }

    private func droppedRow(for item: Item, in conversationId: String, api: API) async throws -> Contract.OutboxEntry? {
        var cursor: String?
        for _ in 0..<5 {
            var components = URLComponents()
            components.path = "/v1/outbox"
            components.queryItems = [URLQueryItem(name: "conversationId", value: conversationId), URLQueryItem(name: "status", value: "dropped")]
                + (cursor.map { [URLQueryItem(name: "cursor", value: $0)] } ?? [])
            let page = try await api.get(components.string ?? "/v1/outbox", as: Contract.OutboxList.self)
            if let row = page.items?.first(where: { $0.sourceId == item.id }) { return row }
            guard let next = page.nextCursor, !next.isEmpty else { return nil }
            cursor = next
        }
        return nil
    }

    // MARK: Pause outgoing messages

    /// The owner's pause switch and which channels are failing, as the settings row shows them.
    func outgoingModel() -> OutgoingModel? {
        guard let api else { return nil }
        return OutgoingModel(
            load: { try await api.get("/v1/outbox?limit=1", as: Contract.OutboxList.self) },
            freeze: { try await api.post("/v1/outbox/freeze", Contract.OutboxFreezeInput(frozen: $0)) })
    }

    // MARK: File versions

    /// `GET /v1/files/history`: the kept versions of one file the agent wrote, newest first.
    func fileVersions(path: String, agentId: String, on: String) async throws -> [Contract.FileSnapshot] {
        guard let api else { return [] }
        var components = URLComponents()
        components.path = "/v1/files/history"
        components.queryItems = [URLQueryItem(name: "path", value: path), URLQueryItem(name: "agentId", value: agentId), URLQueryItem(name: "on", value: on)]
        let history = try await api.get(components.string ?? "/v1/files/history", as: Contract.FileHistory.self)
        return (history.items ?? []).sorted { ($0.createdAt ?? .distantPast) > ($1.createdAt ?? .distantPast) }
    }

    /// `POST /v1/files/restore`: put one kept version back. The server keeps the version it replaced.
    func restoreFileVersion(_ snapshotId: String) async throws {
        guard let api else { return }
        try await api.post("/v1/files/restore", Contract.RestoreFileInput(snapshotId: snapshotId))
    }

    /// The agent a step ran for: the run that holds it.
    func agentId(ofStep step: Step) -> String? {
        runs.first { $0.steps?.contains { $0.id == step.id } == true }?.agentId
    }
}
