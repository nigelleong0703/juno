import Foundation
import Observation
import UIKit

/// The iPhone as a device for the agent (backend BACKEND 7.13, 7.13b). Nothing wakes this app: while it is open in the foreground
/// and its event stream is connected, it tells the server what the owner switched on and the system allowed
/// (`PUT /v1/phone/declaration`); when it goes to the background or the stream drops, it takes that back (`DELETE`). A call
/// arrives as a `device.call` event on the stream, runs through the capability's system (`PhoneSystem`) and is answered with
/// `POST /v1/phone/calls/:id/result`. Calls are never retried here: a repeated delivery of a change gets the answer the first run
/// gave. A capability is on only when the owner switched it on in Settings > iPhone access AND the system still allows it; the
/// system is asked nothing before the switch.
@MainActor
@Observable
final class PhoneDevice {
    static let shared = PhoneDevice()

    /// The system's answer for each capability, as of the last look (app active, a switch, a permission prompt answered).
    private(set) var access: [PhoneCapability: PhoneAccess] = [:]
    /// Bumped when a switch changes, so the settings rows redraw.
    private(set) var switches = 0

    @ObservationIgnored private let systems: [PhoneCapability: any PhoneSystem]
    private var api: API?
    private var streamLive = false
    private var inForeground = false
    /// What the server was last told; nil = nothing declared (or the stream dropped since).
    private var declared: [String]?
    private var inFlight = Set<String>()
    private var executed = ExecutedCalls.load()

    @ObservationIgnored private let uploader = PhoneUploader()

    @ObservationIgnored private let home = HomeSystem()

    private init() {
        let eventKit = EventKitService()
        systems = [
            .calendar: CalendarSystem(service: eventKit), .reminders: RemindersSystem(service: eventKit), .contacts: ContactsSystem(),
            .location: LocationSystem(), .health: HealthSystem(), .photos: PhotosSystem(uploader: uploader),
            .music: MusicSystem(), .home: home,
        ]
        // HomeKit reports the permission answer a moment after its manager starts.
        home.onChange = { [weak self] in self?.accessChanged() }
        refreshAccess()
    }

    private var deviceId: String {
        let key = "phone.deviceId"
        if let id = UserDefaults.standard.string(forKey: key) { return id }
        let id = UUID().uuidString
        UserDefaults.standard.set(id, forKey: key)
        return id
    }

    // MARK: Lifecycle (World calls these)

    func signedIn(_ api: API) {
        self.api = api
        uploader.api = api
        sync()
    }

    /// Before the session goes away: take the declaration back while the request can still be signed.
    func signingOut() {
        withdraw()
        api = nil
        uploader.api = nil
        declared = nil
        streamLive = false
    }

    /// The event stream came up or dropped. A server forgets the declaration with its stream, so a new stream declares again.
    func streamChanged(_ live: Bool) {
        streamLive = live
        if !live { declared = nil }
        sync()
    }

    func appActive(_ active: Bool) {
        inForeground = active
        if active { refreshAccess() }
        sync()
    }

    // MARK: Switches and permission (Settings > iPhone access)

    private func switchKey(_ capability: PhoneCapability) -> String { "phone.on.\(capability.rawValue)" }

    /// What the owner chose. Never chosen: a capability the system already lets Juno into stays on (the calendar and reminders
    /// that were allowed before there were switches), everything else is off.
    private func switchedOn(_ capability: PhoneCapability) -> Bool {
        if let chosen = UserDefaults.standard.object(forKey: switchKey(capability)) as? Bool { return chosen }
        return access[capability]?.usable ?? false
    }

    /// Whether the agent can use it now: switched on and still allowed by the system.
    func isOn(_ capability: PhoneCapability) -> Bool { switchedOn(capability) && (access[capability]?.usable ?? false) }

    func refreshAccess() {
        for (capability, system) in systems { access[capability] = system.access }
    }

    /// The owner flips a switch. Turning one on is the only moment the system is asked.
    func setOn(_ capability: PhoneCapability, _ on: Bool) {
        UserDefaults.standard.set(on, forKey: switchKey(capability))
        switches += 1
        guard on, let system = systems[capability] else { accessChanged(); return }
        Task {
            await system.request()
            accessChanged()
        }
    }

    private func accessChanged() {
        refreshAccess()
        switches += 1
        sync()
    }

    // MARK: Declaration

    private struct Declaration: Encodable {
        var deviceId: String
        var name: String
        var osVersion: String
        var actions: [String]
    }

    /// Declare when the app is open, connected and signed in, and the actions changed; withdraw otherwise.
    private func sync() {
        guard api != nil, streamLive, inForeground else {
            withdraw()
            return
        }
        let actions = PhoneCapability.allCases.filter(isOn).flatMap { capability in systems[capability]?.actions(for: access[capability] ?? .denied) ?? [] }
        guard actions != declared else { return }
        declare(actions)
    }

    private func declare(_ actions: [String]) {
        guard let api else { return }
        declared = actions
        let body = Declaration(deviceId: deviceId, name: UIDevice.current.name, osVersion: "iOS \(UIDevice.current.systemVersion)", actions: actions)
        Task { @MainActor in
            do { try await api.put("/v1/phone/declaration", body) } catch where !error.isCancellation {
                // Not declared (the stream was not open yet, or the network failed): the next stream or foreground try again.
                if self.declared == actions { self.declared = nil }
            } catch {}
        }
    }

    /// Best effort and bounded to the few seconds iOS grants when the app is leaving; the server also drops it with the stream.
    private func withdraw() {
        guard declared != nil, let api else { return }
        declared = nil
        let id = deviceId
        let task = UIApplication.shared.beginBackgroundTask(withName: "phone-withdraw")
        Task { @MainActor in
            try? await api.delete("/v1/phone/declaration?deviceId=\(id)")
            if task != .invalid { UIApplication.shared.endBackgroundTask(task) }
        }
    }

    // MARK: Calls

    private struct Call: Decodable {
        var deviceId: String
        var callId: String
        var action: String
        var args: [String: JSONValue]?
        var expiresAt: String
    }

    /// One `device.call` event. Another phone's call, an expired one, and one already running are ignored.
    func handle(_ frame: Data) {
        guard let api, let call = try? JSONDecoder().decode(Call.self, from: frame), call.deviceId == deviceId else { return }
        guard let deadline = Self.parseDeadline(call.expiresAt), deadline > Date() else { return }
        if let stored = executed.result(call.callId) {
            Task { await Self.post(stored, call.callId, api) }
            return
        }
        guard inFlight.insert(call.callId).inserted else { return }
        Task { @MainActor in
            let result: PhoneResult
            // The capability must still be switched on and allowed: the declaration the server holds can be a moment behind.
            if let capability = PhoneCapability(rawValue: String(call.action.prefix { $0 != "." })), let system = self.systems[capability], self.isOn(capability) {
                do { result = .ok(try await system.run(call.action, call.args ?? [:])) }
                catch let error as PhoneCallError { result = .failed(error.message) }
                catch { result = .failed("The iPhone could not do that: \(error.localizedDescription)") }
                // Only a change is remembered: a repeated read simply runs again.
                if system.changes(call.action) { self.executed.store(call.callId, result) }
            } else {
                result = .failed("Juno isn't allowed to do that on this iPhone right now. The owner can switch it on in Juno > Settings > iPhone access; nothing was done.")
            }
            self.inFlight.remove(call.callId)
            await Self.post(result, call.callId, api)
        }
    }

    private static func parseDeadline(_ text: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: text)
    }

    /// Two tries: the answer is what the agent is waiting for.
    private static func post(_ result: PhoneResult, _ callId: String, _ api: API) async {
        for attempt in 0..<2 {
            do { try await api.post("/v1/phone/calls/\(callId)/result", result); return } catch {
                if error.isCancellation || attempt == 1 { return }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }
}

/// What the phone answers: the data of a call, or the sentence saying why it could not.
enum PhoneResult: Codable, Sendable {
    case ok(JSONValue)
    case failed(String)

    private enum Keys: String, CodingKey { case ok, data, error }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        self = try c.decode(Bool.self, forKey: .ok) ? .ok(try c.decodeIfPresent(JSONValue.self, forKey: .data) ?? .null) : .failed(try c.decode(String.self, forKey: .error))
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .ok(let data): try c.encode(true, forKey: .ok); try c.encode(data, forKey: .data)
        case .failed(let message): try c.encode(false, forKey: .ok); try c.encode(message, forKey: .error)
        }
    }
}

/// The changes this phone already made, by call id, so a call delivered twice (the stream replays after a reconnect) is
/// answered with the first result instead of changing the calendar again. Small and short-lived.
struct ExecutedCalls: Codable {
    private struct Entry: Codable { var id: String; var at: Date; var result: PhoneResult }
    private var entries: [Entry] = []
    private static let key = "phone.executedCalls"
    private static let keep = 50
    private static let maxAge: TimeInterval = 24 * 3600

    static func load() -> ExecutedCalls {
        guard let data = UserDefaults.standard.data(forKey: key), var table = try? JSONDecoder().decode(ExecutedCalls.self, from: data) else { return ExecutedCalls() }
        table.entries.removeAll { Date().timeIntervalSince($0.at) > maxAge }
        return table
    }

    func result(_ id: String) -> PhoneResult? { entries.first { $0.id == id }?.result }

    mutating func store(_ id: String, _ result: PhoneResult) {
        entries.append(Entry(id: id, at: Date(), result: result))
        if entries.count > Self.keep { entries.removeFirst(entries.count - Self.keep) }
        if let data = try? JSONEncoder().encode(self) { UserDefaults.standard.set(data, forKey: Self.key) }
    }
}
