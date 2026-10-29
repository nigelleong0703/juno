import Foundation

/// Documents (BACKEND §5.11a): the routes behind the document viewer, and the cache the Library cell and the viewer share.
extension World {
    private func documentPath(_ id: String, _ tail: String = "") -> String {
        "/v1/documents/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)\(tail)"
    }

    /// GET /v1/documents/:id → the document and its open draft; also keeps `documents[id]` current.
    @discardableResult
    func loadDocument(_ id: String) async throws -> DocView {
        guard let api else { throw APIError.badServer }
        let view = try await api.get(documentPath(id), as: DocView.self)
        documents[id] = view
        return view
    }

    func documentDraft(_ id: String) async throws -> DocDraftBody {
        guard let api else { throw APIError.badServer }
        return try await api.get(documentPath(id, "/draft"), as: DocDraftBody.self)
    }

    func documentVersion(_ id: String, version: Int) async throws -> String {
        guard let api else { throw APIError.badServer }
        return try await api.get(documentPath(id, "/versions/\(version)/content"), as: DocVersionBody.self).markdown
    }

    /// PUT …/draft: the owner's edit. While a draft is open it carries `expectedRevision`; otherwise `baseVersion` (the saved head).
    func saveDocumentDraft(_ id: String, title: String, markdown: String, expectedRevision: Int?, baseVersion: Int?) async throws -> DocDraftBody {
        guard let api else { throw APIError.badServer }
        struct Body: Encodable { var title: String; var markdown: String; var expectedRevision: Int?; var baseVersion: Int? }
        let data = try await api.put(documentPath(id, "/draft"), Body(title: title, markdown: markdown, expectedRevision: expectedRevision, baseVersion: baseVersion))
        return try isoDecoder.decode(DocDraftBody.self, from: data)
    }

    /// POST …/draft/approve or …/draft/decline → the document with whatever draft is still open.
    @discardableResult
    func decideDocumentDraft(_ id: String, draftId: String, revision: Int, approve: Bool) async throws -> DocView {
        guard let api else { throw APIError.badServer }
        struct Body: Encodable { var draftId: String; var expectedRevision: Int }
        let view = try await api.post(documentPath(id, approve ? "/draft/approve" : "/draft/decline"), Body(draftId: draftId, expectedRevision: revision), as: DocView.self)
        documents[id] = view
        return view
    }

    /// POST /v1/documents/:id/conversations: the chat about this document with one agent (the same chat every time).
    func documentConversation(_ id: String, agentId: String) async throws -> Conversation {
        guard let api else { throw APIError.badServer }
        struct Body: Encodable { var agentId: String }
        let conversation = try await api.post(documentPath(id, "/conversations"), Body(agentId: agentId), as: Conversation.self)
        if let i = conversations.firstIndex(where: { $0.id == conversation.id }) { conversations[i] = conversation } else { conversations.append(conversation) }
        return conversation
    }

    /// `document.draft.updated`: the cached document's open draft follows (an approved, declined or replaced draft closes it).
    func applyDocumentDraft(_ draft: DocDraft) {
        guard let id = draft.documentId, var view = documents[id] else { return }
        if draft.isOpen { view.draft = draft } else if view.draft?.id == draft.id { view.draft = nil }
        documents[id] = view
    }
}

/// The wire status of a failed request, for the screens that branch on a 409.
extension APIError {
    var status: Int? {
        switch self {
        case .http(let code, _): code
        case .api(let status, _, _): status
        case .fields: 400
        default: nil
        }
    }
}
