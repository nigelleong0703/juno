import Foundation
import Security

/// The paired login: the backend base URL and the session token the phone approved.
struct WatchSession: Codable, Equatable {
    var server: URL
    var token: String
}

/// The backend the watch was built for (Config/Watch.xcconfig -> Info.plist `JunoServerURL`).
enum WatchServer {
    static var url: URL {
        let text = Bundle.main.object(forInfoDictionaryKey: "JunoServerURL") as? String ?? ""
        return URL(string: text) ?? URL(string: "http://127.0.0.1:8787")!
    }
}

struct WatchAPIError: LocalizedError {
    var status: Int
    var code: String
    var message: String
    var errorDescription: String? { message.isEmpty ? "Server responded \(status)" : message }
}

/// One conversation row, reduced to what the watch needs to pick a chat.
struct WatchConversation: Decodable {
    struct Last: Decodable { var at: Date? }
    var id: String
    var kind: String?
    var agentIds: [String]?
    var lastMessage: Last?
}

/// The agent behind the chat: which character it is drawn as (`avatar.character`, else derived from the id).
struct WatchAgent: Decodable {
    struct Avatar: Decodable { var character: String? }
    var id: String
    var avatar: Avatar?
}

/// One chat item; only messages are used on the watch (the agent's are spoken).
struct WatchItem: Decodable, Identifiable {
    var id: String
    var type: String?
    var text: String?
    var markdown: String?
    var at: Date?
    var fromUser: Bool { type == "user_message" }
    var isMessage: Bool { type == "user_message" || type == "agent_message" }
    var body: String { text ?? markdown ?? "" }
}

/// What `POST /auth/device/code` returns.
struct DeviceCode: Decodable {
    var deviceCode: String
    var userCode: String
    var expiresIn: Int
    var interval: Int?
}

private struct ListResponse<T: Decodable>: Decodable { var items: [T] }

/// Token-only HTTP, like the iPhone app: the server rejects a cookie that arrives without an Origin header.
struct WatchClient {
    var server: URL
    var token: String?

    private static let transport: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.timeoutIntervalForRequest = 20
        return URLSession(configuration: config)
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            if let date = try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) ?? Date(text, strategy: Date.ISO8601FormatStyle()) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "bad date \(text)"))
        }
        return decoder
    }()

    func request(_ path: String, method: String = "GET", body: [String: Any]? = nil, raw: (data: Data, contentType: String)? = nil) async throws -> Data {
        guard let url = URL(string: path, relativeTo: server) else { throw WatchAPIError(status: 0, code: "bad_server", message: "Bad server address") }
        var req = URLRequest(url: url)
        req.httpMethod = method
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response): (Data, URLResponse)
        if let raw {
            req.setValue(raw.contentType, forHTTPHeaderField: "Content-Type")
            (data, response) = try await Self.transport.upload(for: req, from: raw.data)
        } else {
            (data, response) = try await Self.transport.data(for: req)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw Self.failure(status, data) }
        return data
    }

    /// Both error shapes the backend uses: Better Auth `{error, error_description}` and the API `{error:{code,message}}`.
    static func failure(_ status: Int, _ data: Data) -> WatchAPIError {
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        if let nested = object?["error"] as? [String: Any] {
            return WatchAPIError(status: status, code: nested["code"] as? String ?? "", message: nested["message"] as? String ?? "")
        }
        return WatchAPIError(status: status, code: object?["error"] as? String ?? "",
                             message: object?["error_description"] as? String ?? object?["message"] as? String ?? "")
    }

    // MARK: Pairing (Better Auth device authorization)

    func requestDeviceCode() async throws -> DeviceCode {
        try Self.decoder.decode(DeviceCode.self, from: await request("auth/device/code", method: "POST", body: ["client_id": "juno-watch"]))
    }

    /// The session token once the phone approved the code; `authorization_pending` / `slow_down` surface as errors for the caller to retry.
    func redeemDeviceCode(_ deviceCode: String) async throws -> String {
        let data = try await request("auth/device/token", method: "POST", body: [
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code", "device_code": deviceCode, "client_id": "juno-watch",
        ])
        struct Token: Decodable { var accessToken: String }
        return try Self.decoder.decode(Token.self, from: data).accessToken
    }

    // MARK: Chat

    func conversations() async throws -> [WatchConversation] {
        try Self.decoder.decode(ListResponse<WatchConversation>.self, from: await request("v1/conversations")).items
    }

    /// Newest first.
    func items(_ conversationId: String) async throws -> [WatchItem] {
        try Self.decoder.decode(ListResponse<WatchItem>.self, from: await request("v1/conversations/\(conversationId)/items?order=desc&limit=20")).items
    }

    func agent(_ id: String) async throws -> WatchAgent {
        try Self.decoder.decode(WatchAgent.self, from: await request("v1/agents/\(id)"))
    }

    /// POST /v1/transcriptions: the recording (AAC m4a) in, the spoken text out. Nothing is kept server-side.
    func transcribe(_ recording: Data) async throws -> String {
        struct Result: Decodable { var text: String }
        return try Self.decoder.decode(Result.self, from: await request("v1/transcriptions", method: "POST", raw: (recording, "audio/mp4"))).text
    }

    func send(_ text: String, to conversationId: String) async throws {
        _ = try await request("v1/conversations/\(conversationId)/messages", method: "POST", body: ["text": text])
    }
}

/// The session lives in the watch's own keychain, so the watch works without the phone.
enum WatchKeychain {
    private static let service = "io.github.nigelleong0703.juno.watch.session"

    static func load() -> WatchSession? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(WatchSession.self, from: data)
    }

    static func save(_ session: WatchSession?) {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        SecItemDelete(base as CFDictionary)
        guard let session, let data = try? JSONEncoder().encode(session) else { return }
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }
}
