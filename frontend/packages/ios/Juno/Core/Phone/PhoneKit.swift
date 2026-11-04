import Foundation

/// What the iPhone gives an agent while the app is open (backend BACKEND 7.13 and 7.13b). Each part of the phone is a
/// `PhoneCapability` with its own system permission; the owner switches it on in Settings > iPhone access, and only then does the
/// app ask the system and declare it to the server. This file holds the pieces every part shares.

/// A failure the agent can act on: the sentence goes back to it as the tool's error.
struct PhoneCallError: Error, Sendable {
    var message: String
    init(_ message: String) { self.message = message }
}

/// How far the owner has let Juno into one part of the phone (the system's answer, not the switch).
enum PhoneAccess: Equatable, Sendable {
    /// The system has not asked yet.
    case notAsked
    case full
    /// Calendar only: the system lets an app add events without reading any.
    case writeOnly
    /// Contacts and Photos: only what the owner picked in the system's sheet.
    case limited
    /// Health: asked; the system never says which data types were allowed, a type that was refused simply has no data.
    case asked
    case denied
    /// This iPhone cannot do it at all (no Health data on it, say).
    case unavailable

    /// Whether the agent can use it now.
    var usable: Bool {
        switch self {
        case .full, .writeOnly, .limited, .asked: true
        case .notAsked, .denied, .unavailable: false
        }
    }
}

/// The parts of the phone an agent can be given: one row each in Settings > iPhone access, one declared group of actions each.
enum PhoneCapability: String, CaseIterable, Identifiable, Sendable {
    case calendar, reminders, contacts, location, health, photos, music, home

    var id: String { rawValue }

    var title: String {
        switch self {
        case .calendar: "Calendar"
        case .reminders: "Reminders"
        case .contacts: "Contacts"
        case .location: "Location"
        case .health: "Health"
        case .photos: "Photos"
        case .music: "Music"
        case .home: "Home"
        }
    }

    var systemImage: String {
        switch self {
        case .calendar: "calendar"
        case .reminders: "checklist"
        case .contacts: "person.crop.circle"
        case .location: "location"
        case .health: "heart"
        case .photos: "photo.on.rectangle"
        case .music: "music.note"
        case .home: "house"
        }
    }

    /// What an agent may do with it, said to the owner next to the switch.
    var blurb: String {
        switch self {
        case .calendar: "Your agents can look at your calendar and add events."
        case .reminders: "Your agents can look at your reminders, add them and tick them off, also when you arrive somewhere."
        case .contacts: "Your agents can look people up in your contacts and add a contact or a number."
        case .location: "Your agents can ask where you are, when you ask them for something. Only while Juno is open; nothing is tracked."
        case .health: "Your agents can read totals for steps, workouts, sleep and weight. They never write to Health."
        case .photos: "Your agents can search your photos and, when you say yes, send one into a chat. They never change or delete photos. Choose Select Photos to share only some."
        case .music: "Your agents can see what is playing, play a song, album or playlist from your music library, and pause or skip."
        case .home: "Your agents can see your lights and other accessories and turn them on or off or set them. Never locks, garage doors or alarms."
        }
    }
}

/// One part of the phone behind the server's calls: its system permission and the calls that use it. A call's action starts with
/// the capability's id (`contacts.search`), which is how `PhoneDevice` finds the system for it. Nothing here runs until the owner
/// has switched the capability on; `request()` is the only place the system is asked.
@MainActor protocol PhoneSystem {
    /// The system's answer right now.
    var access: PhoneAccess { get }
    /// Shows the system's permission prompt (a no-op once the owner has answered it).
    func request() async
    /// The server actions this access allows (`PHONE_ACTIONS` in the contract); empty when nothing is allowed.
    func actions(for access: PhoneAccess) -> [String]
    /// Runs one call from the server. Throws `PhoneCallError` with a sentence the agent can act on.
    func run(_ action: String, _ args: [String: JSONValue]) async throws -> JSONValue
    /// Whether this call changes something (or sends something off the phone): its answer is remembered by call id, so a call that
    /// arrives twice is answered with the first result instead of being done twice.
    func changes(_ action: String) -> Bool
}

extension JSONValue {
    /// The members when this is an object.
    var fields: [String: JSONValue]? { if case .object(let value) = self { value } else { nil } }
}

extension Dictionary where Key == String, Value == JSONValue {
    func string(_ key: String) -> String? { if case .string(let value)? = self[key] { value } else { nil } }
    func bool(_ key: String) -> Bool? { if case .bool(let value)? = self[key] { value } else { nil } }
    func int(_ key: String) -> Int? { if case .number(let value)? = self[key] { Int(value) } else { nil } }
    func double(_ key: String) -> Double? { if case .number(let value)? = self[key] { value } else { nil } }
    func strings(_ key: String) -> [String] {
        guard case .array(let values)? = self[key] else { return [] }
        return values.compactMap { if case .string(let text) = $0 { text } else { nil } }
    }
    func requiredString(_ key: String) throws -> String {
        guard let value = string(key), !value.trimmingCharacters(in: .whitespaces).isEmpty else { throw PhoneCallError("`\(key)` is required.") }
        return value
    }
}

enum PhoneTime {
    /// ISO 8601 with this iPhone's offset.
    static func iso(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = .current
        return formatter.string(from: date)
    }

    /// ISO 8601 with an offset (or Z), else a local time ("2026-10-22T15:00", "2026-10-22 15:00", "2026-10-22") in this iPhone's zone.
    static func parse(_ text: String) -> Date? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        for options: ISO8601DateFormatter.Options in [[.withInternetDateTime], [.withInternetDateTime, .withFractionalSeconds]] {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = options
            if let date = formatter.date(from: trimmed) { return date }
        }
        for format in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm", "yyyy-MM-dd"] {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = .current
            formatter.dateFormat = format
            if let date = formatter.date(from: trimmed) { return date }
        }
        return nil
    }

    /// The end of a range: a bare date ("2026-10-07") means the end of that day, anything with a time is taken as given.
    static func end(_ args: [String: JSONValue], _ key: String) throws -> Date {
        let date = try date(args, key)
        guard try args.requiredString(key).trimmingCharacters(in: .whitespaces).count <= 10 else { return date }
        return Calendar.current.date(byAdding: .day, value: 1, to: date) ?? date
    }

    static func date(_ args: [String: JSONValue], _ key: String) throws -> Date {
        let text = try args.requiredString(key)
        guard let date = parse(text) else { throw PhoneCallError("`\(key)` (\"\(text)\") is not a time I can read. Use ISO 8601 such as 2026-10-22T15:00:00+08:00.") }
        return date
    }
}
