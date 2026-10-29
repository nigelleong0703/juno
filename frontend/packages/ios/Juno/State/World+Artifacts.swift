import Foundation

/// Published artifacts (BACKEND §5.11): version bytes and the signed address of an HTML page.
extension World {
    struct ArtifactBytes { var name: String; var mimeType: String; var data: Data }

    /// GET /v1/artifacts/:id/versions/:v/download?part=file|preview|thumbnail (base64 body, like a library download).
    func artifactBytes(_ id: String, version: Int, part: String = "file") async throws -> ArtifactBytes {
        guard let api else { throw APIError.badServer }
        struct Reply: Decodable { var name: String; var mimeType: String; var contentBase64: String }
        let reply = try await api.get("/v1/artifacts/\(id)/versions/\(version)/download?part=\(part)", as: Reply.self)
        guard let data = Data(base64Encoded: reply.contentBase64) else { throw APIError.badServer }
        return ArtifactBytes(name: reply.name, mimeType: reply.mimeType, data: data)
    }

    /// POST /v1/artifacts/:id/versions/:v/render-url: a short-lived URL on the separate artifact origin. No token is added to it.
    func artifactRenderURL(_ id: String, version: Int) async throws -> (url: URL, expiresAt: Date) {
        guard let api else { throw APIError.badServer }
        struct Reply: Decodable { var url: String; var expiresAt: Date }
        let reply = try isoDecoder.decode(Reply.self, from: await api.post("/v1/artifacts/\(id)/versions/\(version)/render-url"))
        guard let url = URL(string: reply.url), url.scheme == "https" || url.scheme == "http" else { throw APIError.badServer }
        return (url, reply.expiresAt)
    }
}
