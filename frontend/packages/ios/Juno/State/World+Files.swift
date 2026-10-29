import Foundation

extension API {
    /// GET /v1/library/:id/download → `{name, mimeType, contentBase64}`, written to `tmp/juno-files/<id>/<name>`.
    /// The viewer reads a plain library file through this (`World.itemBytes`).
    func downloadFile(_ id: String) async throws -> URL {
        struct Download: Decodable { var name: String; var contentBase64: String }
        let file = try await get("/v1/library/\(id)/download", as: Download.self)
        guard let data = Data(base64Encoded: file.contentBase64) else { throw APIError.http(502, "The file came back damaged.") }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("juno-files/\(id)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let name = (file.name as NSString).lastPathComponent
        let url = dir.appendingPathComponent(name.isEmpty ? "file" : name)
        try data.write(to: url, options: .atomic)
        return url
    }
}
