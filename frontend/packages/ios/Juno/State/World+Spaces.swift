import Foundation

/// Spaces (BACKEND §5.12): apps an agent built. Status is a passive check (never wakes the computer);
/// opening asks for a fresh 5-minute signed link, which the caller shows in Safari and then drops.
extension World {
    /// GET /v1/spaces/:id: the app with its live status.
    func space(_ id: String) async throws -> Contract.Space {
        guard let api else { throw APIError.badServer }
        return try await api.get("/v1/spaces/\(id)", as: Contract.Space.self)
    }

    /// POST /v1/spaces/:id/open-url: a link on the app's own origin. Request it on tap, never keep it.
    func spaceOpenURL(_ id: String) async throws -> URL {
        try await signedURL("/v1/spaces/\(id)/open-url")
    }

    /// POST /v1/spaces/:id/publish-hosted: publish a copy to a share link, or a new version at the same link.
    /// An empty body keeps the default (anyone with the link, visitors read-only); a republish keeps the access.
    func publishHosted(_ id: String) async throws -> Contract.SpaceHosted {
        guard let api else { throw APIError.badServer }
        return try await api.post("/v1/spaces/\(id)/publish-hosted", Contract.SpacePublishHosted(), as: Contract.SpaceHosted.self)
    }

    /// PATCH /v1/spaces/:id/hosted: who may open the copy (`visibility`) and whether visitors may change its data.
    func updateHosted(_ id: String, _ change: Contract.SpaceHostedUpdate) async throws -> Contract.SpaceHosted {
        guard let api else { throw APIError.badServer }
        return try await api.patch("/v1/spaces/\(id)/hosted", change, as: Contract.SpaceHosted.self)
    }

    /// DELETE /v1/spaces/:id/hosted: stop sharing. The link answers 404 from then on and its data is deleted.
    func revokeHosted(_ id: String) async throws {
        guard let api else { throw APIError.badServer }
        try await api.delete("/v1/spaces/\(id)/hosted")
    }

    /// POST /v1/spaces/:id/hosted/open-url: a 5-minute sign-in link for the owner into the hosted copy. Request it on tap.
    func hostedOpenURL(_ id: String) async throws -> URL {
        try await signedURL("/v1/spaces/\(id)/hosted/open-url")
    }

    /// Any endpoint that answers `{url}` with a short-lived link on the app's own origin.
    private func signedURL(_ path: String) async throws -> URL {
        guard let api else { throw APIError.badServer }
        struct Reply: Decodable { var url: String }
        let reply = try isoDecoder.decode(Reply.self, from: await api.post(path))
        guard let url = URL(string: reply.url), url.scheme == "https" || url.scheme == "http" else { throw APIError.badServer }
        return url
    }
}
