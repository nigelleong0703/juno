import CryptoKit
import Foundation
import GRDB

/// The on-device database the chat reads from (Signal's message DB, Telegram's postbox): the network writes
/// into it, the views read memory that was loaded from it. One SQLite file per (server, user), so another
/// account never sees these rows and signing out deletes the file.
///
/// Tables
///   conversation(id, json, sortAt)      the conversation list, as last fetched
///   item(id, conversationId, at, rev, json)  one row per transcript item; `rev` counts content changes
///   chat(conversationId, olderCursor, reachedStart, openedAt)
///                                       a chat has a row once its NEWEST page is stored; the stored items are
///                                       contiguous from the newest down to some oldest one, `olderCursor` (the
///                                       server's keyset cursor) pages below it, nil + reachedStart = the beginning
///   blob(key, json)                     small lists chat rows render from (agents, runs, requests, files, routines)
///   meta(key, value)                    the event-stream cursor
final class LocalStore: Sendable {
    private let pool: DatabasePool
    let url: URL

    /// What a chat knows about its stored history.
    struct ChatState: Equatable, Sendable {
        var olderCursor: String?
        var reachedStart: Bool
    }

    init(url: URL) throws {
        self.url = url
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        var config = Configuration()
        config.prepareDatabase { db in try db.execute(sql: "PRAGMA synchronous = NORMAL") }
        pool = try DatabasePool(path: url.path, configuration: config)
        try Self.migrator.migrate(pool)
    }

    private static var migrator: DatabaseMigrator {
        var m = DatabaseMigrator()
        m.registerMigration("v1") { db in
            try db.execute(sql: """
                CREATE TABLE conversation (id TEXT PRIMARY KEY, json BLOB NOT NULL, sortAt REAL NOT NULL DEFAULT 0);
                CREATE TABLE item (
                    id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, at REAL NOT NULL,
                    rev INTEGER NOT NULL DEFAULT 1, json BLOB NOT NULL);
                CREATE INDEX item_by_chat ON item (conversationId, at, id);
                CREATE TABLE chat (
                    conversationId TEXT PRIMARY KEY, olderCursor TEXT, reachedStart INTEGER NOT NULL DEFAULT 0,
                    openedAt REAL NOT NULL DEFAULT 0);
                CREATE TABLE blob (key TEXT PRIMARY KEY, json BLOB NOT NULL);
                CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                """)
        }
        return m
    }

    // MARK: Location (per user and server)

    static func directory() -> URL {
        URL.applicationSupportDirectory.appending(path: "Juno/Store", directoryHint: .isDirectory)
    }

    static func fileName(server: URL, userId: String) -> String {
        let digest = SHA256.hash(data: Data("\(server.absoluteString.lowercased())|\(userId)".utf8))
        return "store-" + digest.prefix(10).map { String(format: "%02x", $0) }.joined() + ".sqlite"
    }

    static func open(_ session: Session) -> LocalStore? {
        try? LocalStore(url: directory().appending(path: fileName(server: session.server, userId: session.userId)))
    }

    /// Sign-out: every account's file goes (a store is also never reused after its owner signs out).
    static func deleteAll() {
        try? FileManager.default.removeItem(at: directory())
    }

    // MARK: Coding

    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        e.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(formatter.string(from: date))
        }
        return e
    }()

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) -> T? { try? isoDecoder.decode(T.self, from: data) }
    private static func at(_ item: Item) -> Double { (item.at ?? Date()).timeIntervalSince1970 }

    // MARK: Conversation list and small lists

    func saveConversations(_ list: [Conversation]) {
        try? pool.write { db in
            try db.execute(sql: "DELETE FROM conversation")
            for c in list {
                guard let json = try? Self.encoder.encode(c) else { continue }
                try db.execute(sql: "INSERT INTO conversation (id, json, sortAt) VALUES (?, ?, ?)",
                               arguments: [c.id, json, (c.lastItemAt ?? .distantPast).timeIntervalSince1970])
            }
        }
    }

    func conversations() -> [Conversation] {
        let rows = (try? pool.read { try Row.fetchAll($0, sql: "SELECT json FROM conversation ORDER BY sortAt DESC") }) ?? []
        return rows.compactMap { row in (row["json"] as Data?).flatMap { decode(Conversation.self, $0) } }
    }

    func saveBlob<T: Encodable>(_ key: String, _ value: T) {
        guard let json = try? Self.encoder.encode(value) else { return }
        try? pool.write { try $0.execute(sql: "INSERT OR REPLACE INTO blob (key, json) VALUES (?, ?)", arguments: [key, json]) }
    }

    func blob<T: Decodable>(_ key: String, as type: T.Type) -> T? {
        let data = try? pool.read { try Data.fetchOne($0, sql: "SELECT json FROM blob WHERE key = ?", arguments: [key]) }
        return data.flatMap { decode(T.self, $0) }
    }

    // MARK: Event cursor

    func cursor() -> Int? {
        (try? pool.read { try String.fetchOne($0, sql: "SELECT value FROM meta WHERE key = 'cursor'") }).flatMap { $0.flatMap(Int.init) }
    }

    func setCursor(_ value: Int?) {
        try? pool.write { db in
            if let value { try db.execute(sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('cursor', ?)", arguments: [String(value)]) }
            else { try db.execute(sql: "DELETE FROM meta WHERE key = 'cursor'") }
        }
    }

    // MARK: Items

    /// A chat's newest page, replacing whatever was stored (first open, reset). `items` ascending.
    func replaceNewest(_ conversationId: String, items: [Item], olderCursor: String?) {
        try? pool.write { db in
            try db.execute(sql: "DELETE FROM item WHERE conversationId = ?", arguments: [conversationId])
            try Self.upsert(db, conversationId, items)
            try db.execute(sql: """
                INSERT INTO chat (conversationId, olderCursor, reachedStart, openedAt) VALUES (?, ?, ?, ?)
                ON CONFLICT(conversationId) DO UPDATE SET olderCursor = excluded.olderCursor, reachedStart = excluded.reachedStart
                """, arguments: [conversationId, olderCursor, olderCursor == nil, Date().timeIntervalSince1970])
        }
    }

    /// Items that arrived live. Only chats whose newest page is stored keep them (otherwise the rows would not be contiguous).
    @discardableResult
    func upsertLive(_ conversationId: String, _ items: [Item]) -> Bool {
        (try? pool.write { db in
            guard try Bool.fetchOne(db, sql: "SELECT EXISTS (SELECT 1 FROM chat WHERE conversationId = ?)", arguments: [conversationId]) == true else { return false }
            try Self.upsert(db, conversationId, items)
            return true
        }) ?? false
    }

    /// An older page fetched with the cursor: stored below the window, and the cursor moves down.
    func appendOlder(_ conversationId: String, items: [Item], olderCursor: String?) {
        try? pool.write { db in
            try Self.upsert(db, conversationId, items)
            try db.execute(sql: "UPDATE chat SET olderCursor = ?, reachedStart = ? WHERE conversationId = ?",
                           arguments: [olderCursor, olderCursor == nil, conversationId])
        }
    }

    func deleteItem(_ id: String) {
        try? pool.write { try $0.execute(sql: "DELETE FROM item WHERE id = ?", arguments: [id]) }
    }

    func deleteChat(_ conversationId: String) {
        try? pool.write { db in
            try db.execute(sql: "DELETE FROM item WHERE conversationId = ?", arguments: [conversationId])
            try db.execute(sql: "DELETE FROM chat WHERE conversationId = ?", arguments: [conversationId])
        }
    }

    /// Reset / missing cursor: nothing stored about history can be trusted any more.
    func wipeHistory() {
        try? pool.write { db in
            try db.execute(sql: "DELETE FROM item")
            try db.execute(sql: "DELETE FROM chat")
            try db.execute(sql: "DELETE FROM meta WHERE key = 'cursor'")
        }
    }

    func touch(_ conversationId: String) {
        try? pool.write { try $0.execute(sql: "UPDATE chat SET openedAt = ? WHERE conversationId = ?", arguments: [Date().timeIntervalSince1970, conversationId]) }
    }

    func chatState(_ conversationId: String) -> ChatState? {
        let row = try? pool.read { try Row.fetchOne($0, sql: "SELECT olderCursor, reachedStart FROM chat WHERE conversationId = ?", arguments: [conversationId]) }
        return row.map { ChatState(olderCursor: $0["olderCursor"], reachedStart: ($0["reachedStart"] as Int? ?? 0) != 0) }
    }

    /// Chats opened (or seeded) most recently, newest first.
    func recentChats(limit: Int) -> [String] {
        (try? pool.read { try String.fetchAll($0, sql: "SELECT conversationId FROM chat ORDER BY openedAt DESC LIMIT ?", arguments: [limit]) }) ?? []
    }

    /// The newest `limit` items of a chat, ascending.
    func newest(_ conversationId: String, limit: Int) -> [Item] {
        let rows = (try? pool.read {
            try Row.fetchAll($0, sql: "SELECT json FROM item WHERE conversationId = ? ORDER BY at DESC, id DESC LIMIT ?", arguments: [conversationId, limit])
        }) ?? []
        return rows.reversed().compactMap { row in (row["json"] as Data?).flatMap { decode(Item.self, $0) } }
    }

    /// Up to `limit` items strictly older than `item`, ascending.
    func older(_ conversationId: String, than item: Item, limit: Int) -> [Item] {
        let rows = (try? pool.read {
            try Row.fetchAll($0, sql: """
                SELECT json FROM item WHERE conversationId = ? AND (at < ? OR (at = ? AND id < ?))
                ORDER BY at DESC, id DESC LIMIT ?
                """, arguments: [conversationId, Self.at(item), Self.at(item), item.id, limit])
        }) ?? []
        return rows.reversed().compactMap { row in (row["json"] as Data?).flatMap { decode(Item.self, $0) } }
    }

    func itemCount(_ conversationId: String) -> Int {
        (try? pool.read { try Int.fetchOne($0, sql: "SELECT COUNT(*) FROM item WHERE conversationId = ?", arguments: [conversationId]) }) ?? 0
    }

    private static func upsert(_ db: Database, _ conversationId: String, _ items: [Item]) throws {
        for item in items {
            guard let json = try? encoder.encode(item) else { continue }
            try db.execute(sql: """
                INSERT INTO item (id, conversationId, at, rev, json) VALUES (?, ?, ?, 1, ?)
                ON CONFLICT(id) DO UPDATE SET at = excluded.at, json = excluded.json, rev = rev + 1 WHERE json != excluded.json
                """, arguments: [item.id, conversationId, at(item), json])
        }
    }
}
