import Foundation
import Security

// The real backend: the same HTTP API and SSE stream the web/desktop client uses
// (packages/client/src/http/*). Account mode signs in with email + password and sends the
// session token as a Bearer header (Better Auth `bearer()` plugin, backend/api/src/account-auth.ts).

struct Session: Codable, Equatable {
    var server: URL
    var token: String
    var userId: String
    var name: String
    var email: String
}

enum APIError: LocalizedError {
    case http(Int, String)
    /// A JSON error body `{error:{code,message}}`: `code` is stable and meant for the client to branch on.
    case api(status: Int, code: String, message: String)
    /// A 400 with per-field problems (`{error:{details:{fields:{<id>: "message"}}}}`): the keys are question field ids.
    case fields(message: String, errors: [String: String])
    case badServer
    case notSignedIn
    var errorDescription: String? {
        switch self {
        case .http(let code, let message): message.isEmpty ? "Server responded \(code)" : message
        case .api(let status, _, let message): message.isEmpty ? "Server responded \(status)" : message
        case .fields(let message, _): message.isEmpty ? "Some answers need fixing." : message
        case .badServer: "Enter a server address like http://100.x.y.z:8787"
        case .notSignedIn: "Sign in to a server first."
        }
    }
}

/// Dates come as ISO 8601 with or without fractional seconds.
let isoDecoder: JSONDecoder = {
    let d = JSONDecoder()
    let frac = ISO8601DateFormatter()
    frac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let plain = ISO8601DateFormatter()
    d.dateDecodingStrategy = .custom { decoder in
        let s = try decoder.singleValueContainer().decode(String.self)
        if let date = frac.date(from: s) ?? plain.date(from: s) { return date }
        throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "bad date \(s)"))
    }
    return d
}()

private struct ListResponse<T: Decodable>: Decodable { var items: [T]; var nextCursor: String? }

/// Token-only HTTP: no cookie jar. Better Auth also sets a session cookie on sign-in, and a request that
/// carries that cookie without an Origin header is rejected ("Missing or null Origin") — native apps send
/// no Origin, so cookies must never be stored or sent.
let http: URLSession = {
    let config = URLSessionConfiguration.default
    config.httpCookieStorage = nil
    config.httpShouldSetCookies = false
    config.httpCookieAcceptPolicy = .never
    return URLSession(configuration: config)
}()

struct API {
    var session: Session
    var transport: URLSession = http

    private func request(_ path: String, method: String = "GET", body: Encodable? = nil, headers: [String: String] = [:]) async throws -> Data {
        guard let url = URL(string: path, relativeTo: session.server) else { throw APIError.badServer }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(session.token)", forHTTPHeaderField: "Authorization")
        for (name, value) in headers { req.setValue(value, forHTTPHeaderField: name) }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(body)
        }
        let (data, response) = try await transport.data(for: req)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else { throw Self.failure(code, data) }
        return data
    }

    static func failure(_ status: Int, _ data: Data) -> APIError {
        if let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
           let error = object["error"] as? [String: Any], let errorCode = error["code"] as? String {
            let errors = fieldErrors(error)
            if status == 400, !errors.isEmpty { return .fields(message: error["message"] as? String ?? "", errors: errors) }
            return .api(status: status, code: errorCode, message: error["message"] as? String ?? "")
        }
        return .http(status, message(data))
    }

    /// Per-field messages from an error object: `details.fields` / `fields` / `fieldErrors`, as `{id: message}` or `[{id|field, message}]`.
    static func fieldErrors(_ error: [String: Any]) -> [String: String] {
        let details = error["details"] as? [String: Any]
        let raw = details?["fields"] ?? details?["fieldErrors"] ?? error["fields"] ?? error["fieldErrors"] ?? error["details"]
        var out: [String: String] = [:]
        if let map = raw as? [String: Any] {
            for (key, value) in map {
                if let text = value as? String { out[key] = text }
                else if let list = value as? [String], let first = list.first { out[key] = first }
            }
        } else if let list = raw as? [[String: Any]] {
            for item in list {
                if let id = (item["id"] ?? item["field"] ?? item["fieldId"]) as? String, let text = item["message"] as? String { out[id] = text }
            }
        }
        return out
    }

    static func message(_ data: Data) -> String {
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return "" }
        if let nested = object["error"] as? [String: Any], let text = nested["message"] as? String { return text }
        // OAuth-style bodies (`{error: "invalid_request", error_description: "..."}`): the description is the readable part.
        return object["message"] as? String ?? object["error_description"] as? String ?? object["error"] as? String ?? ""
    }

    func list<T: Decodable>(_ path: String, as: T.Type) async throws -> [T] {
        try isoDecoder.decode(ListResponse<T>.self, from: await request(path)).items
    }

    /// One page of a cursor-paged list: the items and the cursor for the next page (nil on the last).
    func page<T: Decodable>(_ path: String, as: T.Type) async throws -> (items: [T], next: String?) {
        let r = try isoDecoder.decode(ListResponse<T>.self, from: await request(path))
        return (r.items, r.nextCursor)
    }

    /// The raw bytes of a GET (an image download).
    func bytes(_ path: String) async throws -> Data { try await request(path) }

    func get<T: Decodable>(_ path: String, as: T.Type) async throws -> T {
        try isoDecoder.decode(T.self, from: await request(path))
    }

    /// A POST whose body is the raw bytes, under their own content type (the dictation recording).
    func postRaw(_ path: String, _ body: Data, contentType: String) async throws -> Data {
        guard let url = URL(string: path, relativeTo: session.server) else { throw APIError.badServer }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(session.token)", forHTTPHeaderField: "Authorization")
        req.setValue(contentType, forHTTPHeaderField: "Content-Type")
        let (data, response) = try await transport.upload(for: req, from: body)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else { throw Self.failure(code, data) }
        return data
    }

    @discardableResult
    func post(_ path: String, _ body: Encodable? = nil) async throws -> Data {
        try await request(path, method: "POST", body: body)
    }

    /// A POST whose reply is a JSON body of type `T`.
    func post<T: Decodable>(_ path: String, _ body: Encodable?, as: T.Type) async throws -> T {
        try isoDecoder.decode(T.self, from: await request(path, method: "POST", body: body))
    }

    /// A screen's take-over or return: the control epoch the person saw goes as `x-expect-epoch`, and the server does nothing when
    /// control changed hands since (the reply is then the current row).
    func postControl(_ path: String, expectEpoch: Int?) async throws -> Contract.ScreenResponse {
        let headers = expectEpoch.map { ["x-expect-epoch": String($0)] } ?? [:]
        return try isoDecoder.decode(Contract.ScreenResponse.self, from: await request(path, method: "POST", headers: headers))
    }

    @discardableResult
    func put(_ path: String, _ body: Encodable) async throws -> Data {
        try await request(path, method: "PUT", body: body)
    }

    func patch(_ path: String, _ body: Encodable) async throws {
        _ = try await request(path, method: "PATCH", body: body)
    }

    /// A PATCH whose reply is a JSON body of type `T`.
    func patch<T: Decodable>(_ path: String, _ body: Encodable, as: T.Type) async throws -> T {
        try isoDecoder.decode(T.self, from: await request(path, method: "PATCH", body: body))
    }

    /// GET /v1/home?path=<prefix>: the user's /juno files whose path starts with `prefix` (agent persona files, USER.md, …).
    func homeFiles(prefix: String) async throws -> [Contract.AgentHomeFile] {
        var components = URLComponents()
        components.path = "/v1/home"
        components.queryItems = [URLQueryItem(name: "path", value: prefix)]
        struct Reply: Decodable { var files: [Contract.AgentHomeFile] }
        return try await get(components.string ?? "/v1/home", as: Reply.self).files
    }

    /// PUT /v1/home/<path>: with `expectedHash` the server refuses (409 `HOME_CONFLICT`) when the file changed since it was loaded.
    func writeHomeFile(path: String, content: String, expectedHash: String?) async throws {
        struct Body: Encodable { var content: String; var expectedHash: String? }
        let encoded = path.split(separator: "/").map { $0.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String($0) }.joined(separator: "/")
        _ = try await request("/v1/home/\(encoded)", method: "PUT", body: Body(content: content, expectedHash: expectedHash))
    }

    /// GET /v1/memory/claims: what the agents distilled about the user, newest first, with the quote that proves each.
    func memoryClaims() async throws -> [Contract.MemoryClaim] {
        try await get("/v1/memory/claims", as: Contract.MemoryClaimsResult.self).claims ?? []
    }

    /// POST /v1/memory/forget: retract these claims and remove every line that carries their tag.
    func forgetMemory(claimIds: [String]) async throws -> Contract.ForgetMemoryResult {
        try isoDecoder.decode(Contract.ForgetMemoryResult.self, from: await post("/v1/memory/forget", Contract.ForgetMemoryInput(claimIds: claimIds)))
    }

    /// GET /v1/memory/search?q=: ranked chunks of MEMORY.md, memory/** and people/**.
    func searchMemory(_ query: String) async throws -> [Contract.MemorySearchHit] {
        var components = URLComponents()
        components.path = "/v1/memory/search"
        components.queryItems = [URLQueryItem(name: "q", value: query)]
        return try await get(components.string ?? "/v1/memory/search", as: Contract.MemorySearchResult.self).hits ?? []
    }

    func delete(_ path: String) async throws {
        _ = try await request(path, method: "DELETE")
    }

    /// GET /auth/device?user_code=: checks the code shown on a watch before anything is approved. 400 when it is unknown or expired.
    func claimWatch(_ code: String) async throws {
        var components = URLComponents()
        components.path = "/auth/device"
        components.queryItems = [URLQueryItem(name: "user_code", value: code)]
        _ = try await request(components.string ?? "/auth/device")
    }

    /// POST /auth/device/approve: lets the claimed watch sign in as this account.
    func approveWatch(_ code: String) async throws {
        try await post("/auth/device/approve", ["userCode": code])
    }

    /// POST /auth/device/deny: refuses the claimed watch.
    func denyWatch(_ code: String) async throws {
        try await post("/auth/device/deny", ["userCode": code])
    }

    /// POST /auth/sign-in/email → { token, user } (account mode).
    static func signIn(server: URL, email: String, password: String) async throws -> Session {
        try await auth(server: server, path: "auth/sign-in/email", body: ["email": email, "password": password])
    }

    /// POST /auth/sign-up/email → { token, user }; a new account starts empty.
    static func signUp(server: URL, name: String, email: String, password: String) async throws -> Session {
        try await auth(server: server, path: "auth/sign-up/email", body: ["name": name, "email": email, "password": password])
    }

    private static func auth(server: URL, path: String, body: [String: String]) async throws -> Session {
        var req = URLRequest(url: server.appending(path: path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await http.data(for: req)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else { throw APIError.http(code, message(data)) }
        struct User: Decodable { var id: String; var name: String; var email: String }
        struct Result: Decodable { var token: String; var user: User }
        let r = try JSONDecoder().decode(Result.self, from: data)
        return Session(server: server, token: r.token, userId: r.user.id, name: r.user.name, email: r.user.email)
    }
}

// MARK: - SSE (GET /v1/events): one frame per blank-line-separated block; `id:` is the resume cursor.

/// One SSE event: its payload and its log id (the resume cursor), or the server's `reset` (our cursor fell off the log).
struct EventFrame: Sendable {
    var id: Int?
    var data: Data
    var isReset = false
}

struct EventStream {
    var session: Session
    /// Start after this event id (GET /v1/events/cursor); nil = from the start of the retained log.
    var after: String? = nil
    /// true once the stream is open, false when it drops (the UI shows "Reconnecting…").
    var onLive: @MainActor (Bool) -> Void = { _ in }

    /// Yields each event until cancelled; reconnects with Last-Event-ID after drops.
    func frames() -> AsyncStream<EventFrame> {
        AsyncStream { continuation in
            let task = Task {
                var lastId: String? = after
                var backoff: UInt64 = 1
                while !Task.isCancelled {
                    do {
                        var req = URLRequest(url: session.server.appending(path: "v1/events"))
                        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                        req.setValue("Bearer \(session.token)", forHTTPHeaderField: "Authorization")
                        // Presence: while this stream is open the agent knows the user has the iPhone app open.
                        req.setValue("ios", forHTTPHeaderField: "x-juno-client")
                        if let lastId { req.setValue(lastId, forHTTPHeaderField: "Last-Event-ID") }
                        req.timeoutInterval = 3600
                        let (bytes, response) = try await http.bytes(for: req)
                        let ok = ((response as? HTTPURLResponse)?.statusCode ?? 0) == 200
                        await onLive(ok)
                        var data: [String] = []
                        var event: String?
                        // Not `bytes.lines`: it drops empty lines, and the empty line is what ends an SSE event,
                        // so no event was ever handed on.
                        for try await line in SSELines(bytes: bytes) {
                            if line.isEmpty {
                                if event == "reset" { lastId = nil; continuation.yield(EventFrame(id: nil, data: Data(), isReset: true)) }
                                else if !data.isEmpty { continuation.yield(EventFrame(id: lastId.flatMap(Int.init), data: Data(data.joined(separator: "\n").utf8))); backoff = 1 }
                                data = []; event = nil
                                continue
                            }
                            if line.hasPrefix("data:") { data.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)) }
                            else if line.hasPrefix("id:") { lastId = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces) }
                            else if line.hasPrefix("event:") { event = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces) }
                        }
                    } catch {}
                    if !Task.isCancelled { await onLive(false) }
                    try? await Task.sleep(nanoseconds: min(backoff, 15) * 1_000_000_000)
                    backoff *= 2
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

// MARK: - Keychain (the session token never goes to UserDefaults)

enum SessionStore {
    private static let service = "io.github.nigelleong0703.juno.session"

    static func load() -> Session? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(Session.self, from: data)
    }

    static func save(_ session: Session?) {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        SecItemDelete(base as CFDictionary)
        guard let session, let data = try? JSONEncoder().encode(session) else { return }
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }
}

/// Lines of an SSE body, keeping empty ones (they end each event). Splits on \n, drops a trailing \r.
struct SSELines<Bytes: AsyncSequence>: AsyncSequence where Bytes.Element == UInt8 {
    typealias Element = String
    var bytes: Bytes

    struct AsyncIterator: AsyncIteratorProtocol {
        var inner: Bytes.AsyncIterator
        var buffer: [UInt8] = []
        mutating func next() async throws -> String? {
            while let byte = try await inner.next() {
                if byte == UInt8(ascii: "\n") {
                    if buffer.last == UInt8(ascii: "\r") { buffer.removeLast() }
                    defer { buffer.removeAll(keepingCapacity: true) }
                    return String(decoding: buffer, as: UTF8.self)
                }
                buffer.append(byte)
            }
            guard !buffer.isEmpty else { return nil }
            defer { buffer.removeAll() }
            return String(decoding: buffer, as: UTF8.self)
        }
    }
    func makeAsyncIterator() -> AsyncIterator { AsyncIterator(inner: bytes.makeAsyncIterator()) }
}
