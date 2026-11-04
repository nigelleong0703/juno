import Foundation
import HomeKit

/// The home for the agent (backend BACKEND 7.13b): list homes, rooms and accessories with their last known state, and change one
/// value (on/off, brightness, target temperature, position). Locks, garage doors, doors and security systems are listed (a lock
/// shows locked or unlocked) but never operated, whatever the agent asks. HomeKit asks for permission the first time a
/// `HMHomeManager` is created, so the manager is made only after the owner turned the switch on.
@MainActor final class HomeSystem: NSObject, PhoneSystem, HMHomeManagerDelegate {
    private static let askedKey = "phone.home.asked"
    /// Tells `PhoneDevice` the system's answer arrived or changed (HomeKit reports it after the manager starts).
    var onChange: (() -> Void)?

    private var manager: HMHomeManager?
    private var loaded = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    /// A manager exists only once the owner has been asked; after a relaunch it is made again, without a new prompt.
    private func existing() -> HMHomeManager? {
        if manager == nil, UserDefaults.standard.bool(forKey: Self.askedKey) { start() }
        return manager
    }

    private func start() {
        let created = HMHomeManager()
        created.delegate = self
        manager = created
    }

    var access: PhoneAccess {
        guard let status = existing()?.authorizationStatus else { return .notAsked }
        if status.contains(.restricted) { return .unavailable }
        if status.contains(.authorized) { return .full }
        return status.contains(.determined) ? .denied : .notAsked
    }

    func request() async {
        if manager == nil { start() }
        UserDefaults.standard.set(true, forKey: Self.askedKey)
        await homesLoaded(timeout: 90)
    }

    func actions(for access: PhoneAccess) -> [String] { access.usable ? ["home.read", "home.write"] : [] }
    func changes(_ action: String) -> Bool { action == "home.set" }

    func run(_ action: String, _ args: [String: JSONValue]) async throws -> JSONValue {
        guard access.usable, let manager = existing() else { throw PhoneCallError("Juno isn't allowed to use the home on this iPhone. The owner can switch it on in Juno > Settings > iPhone access.") }
        await homesLoaded(timeout: 10)
        switch action {
        case "home.list": return await list(manager, args)
        case "home.set": return try await set(manager, args)
        default: throw PhoneCallError("This version of Juno on the iPhone does not know \(action).")
        }
    }

    // MARK: Loading

    /// HomeKit delivers the homes (and the permission answer) a moment after the manager starts.
    private func homesLoaded(timeout: Double) async {
        if loaded { return }
        await withCheckedContinuation { continuation in
            waiting.append(continuation)
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                self.releaseWaiting()
            }
        }
    }

    private func releaseWaiting() {
        let pending = waiting
        waiting = []
        pending.forEach { $0.resume() }
    }

    nonisolated func homeManagerDidUpdateHomes(_ manager: HMHomeManager) {
        Task { @MainActor in
            self.loaded = true
            self.releaseWaiting()
            self.onChange?()
        }
    }

    nonisolated func homeManager(_ manager: HMHomeManager, didUpdate status: HMHomeManagerAuthorizationStatus) {
        Task { @MainActor in
            if status.contains(.determined) { self.releaseWaiting() }
            self.onChange?()
        }
    }

    // MARK: List

    private static let listed = 60

    private func list(_ manager: HMHomeManager, _ args: [String: JSONValue]) async -> JSONValue {
        let wantedHome = args.string("home"), wantedRoom = args.string("room")
        var accessories: [(home: HMHome, accessory: HMAccessory)] = []
        for home in manager.homes where wantedHome == nil || Self.same(home.name, wantedHome) {
            for accessory in home.accessories where Self.listable(accessory) && (wantedRoom == nil || Self.same(accessory.room?.name, wantedRoom)) {
                accessories.append((home, accessory))
            }
        }
        let shown = accessories.prefix(Self.listed)
        await refresh(shown.flatMap { Self.characteristics(of: $0.accessory) })
        var homes: [JSONValue] = []
        for home in manager.homes {
            let mine = shown.filter { $0.home === home }
            guard !mine.isEmpty else { continue }
            let rooms = Dictionary(grouping: mine, by: { $0.accessory.room?.name ?? "No room" })
            homes.append(.object([
                "name": .string(home.name),
                "rooms": .array(rooms.keys.sorted().map { room in
                    .object(["name": .string(room), "accessories": .array(rooms[room, default: []].map { Self.json($0.accessory) })])
                }),
            ]))
        }
        var out: [String: JSONValue] = ["homes": .array(homes)]
        if accessories.count > Self.listed { out["more"] = .string("\(accessories.count - Self.listed) more accessories; ask for one room at a time.") }
        if manager.homes.isEmpty { out["note"] = .string("There is no home set up in the Home app on this iPhone.") }
        return .object(out)
    }

    private static func same(_ a: String?, _ b: String?) -> Bool { a?.caseInsensitiveCompare(b ?? "") == .orderedSame }

    /// A bridge is plumbing, not something to turn on.
    private static func listable(_ accessory: HMAccessory) -> Bool { accessory.category.categoryType != HMAccessoryCategoryTypeBridge }

    /// What an agent must never operate.
    private static func blocked(_ accessory: HMAccessory) -> Bool {
        [HMAccessoryCategoryTypeDoorLock, HMAccessoryCategoryTypeGarageDoorOpener, HMAccessoryCategoryTypeSecuritySystem, HMAccessoryCategoryTypeDoor].contains(accessory.category.categoryType)
    }

    private static let shown = [HMCharacteristicTypePowerState, HMCharacteristicTypeBrightness, HMCharacteristicTypeCurrentTemperature,
                                HMCharacteristicTypeTargetTemperature, HMCharacteristicTypeCurrentPosition, HMCharacteristicTypeCurrentLockMechanismState]

    private static func characteristics(of accessory: HMAccessory) -> [HMCharacteristic] {
        guard accessory.isReachable else { return [] }
        return accessory.services.flatMap(\.characteristics).filter { shown.contains($0.characteristicType) }
    }

    /// Read the values that matter, all at once, for at most six seconds; whatever has not answered keeps its last known value.
    private func refresh(_ characteristics: [HMCharacteristic]) async {
        guard !characteristics.isEmpty else { return }
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            let once = Once(done)
            var remaining = characteristics.count
            for characteristic in characteristics {
                Task { @MainActor in
                    do { try await characteristic.readValue() } catch {}
                    remaining -= 1
                    if remaining == 0 { once.finish() }
                }
            }
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 6_000_000_000)
                once.finish()
            }
        }
    }

    @MainActor private final class Once {
        private var continuation: CheckedContinuation<Void, Never>?
        init(_ continuation: CheckedContinuation<Void, Never>) { self.continuation = continuation }
        func finish() { continuation?.resume(); continuation = nil }
    }

    private static func json(_ accessory: HMAccessory) -> JSONValue {
        var state: [String: JSONValue] = [:]
        for characteristic in accessory.services.flatMap(\.characteristics) {
            guard let value = characteristic.value else { continue }
            let number = (value as? NSNumber)?.doubleValue
            switch characteristic.characteristicType {
            case HMCharacteristicTypePowerState: state["on"] = .bool((value as? NSNumber)?.boolValue ?? false)
            case HMCharacteristicTypeBrightness: if let number { state["brightness"] = .number(number) }
            case HMCharacteristicTypeCurrentTemperature: if let number { state["temperatureC"] = .number((number * 10).rounded() / 10) }
            case HMCharacteristicTypeTargetTemperature: if let number { state["targetTemperatureC"] = .number((number * 10).rounded() / 10) }
            case HMCharacteristicTypeCurrentPosition: if let number { state["position"] = .number(number) }
            case HMCharacteristicTypeCurrentLockMechanismState: if let number { state["lock"] = .string(number == 1 ? "locked" : number == 0 ? "unlocked" : "other") }
            default: break
            }
        }
        var out: [String: JSONValue] = ["name": .string(accessory.name), "type": .string(accessory.category.localizedDescription), "reachable": .bool(accessory.isReachable)]
        if !state.isEmpty { out["state"] = .object(state) }
        if blocked(accessory) { out["note"] = .string("Juno does not operate this kind of accessory.") }
        return .object(out)
    }

    // MARK: Set

    private func set(_ manager: HMHomeManager, _ args: [String: JSONValue]) async throws -> JSONValue {
        let name = try args.requiredString("accessory"), property = try args.requiredString("property")
        let candidates = manager.homes.filter { args.string("home") == nil || Self.same($0.name, args.string("home")) }
            .flatMap(\.accessories)
            .filter { (Self.same($0.name, name) || $0.uniqueIdentifier.uuidString == name) && (args.string("room") == nil || Self.same($0.room?.name, args.string("room"))) }
        guard let accessory = candidates.first else { throw PhoneCallError("No accessory called \"\(name)\". phone_home_list shows the names.") }
        guard candidates.count == 1 else {
            let rooms = candidates.map { $0.room?.name ?? "no room" }.joined(separator: ", ")
            throw PhoneCallError("More than one accessory is called \"\(name)\" (in: \(rooms)). Add the room.")
        }
        guard !Self.blocked(accessory) else { throw PhoneCallError("Juno does not operate locks, garage doors, doors or alarms. Ask the owner to do that themselves. Nothing was changed.") }
        guard accessory.isReachable else { throw PhoneCallError("\(accessory.name) isn't reachable right now (off, out of range or offline). Nothing was changed.") }
        let type: String
        switch property {
        case "power": type = HMCharacteristicTypePowerState
        case "brightness": type = HMCharacteristicTypeBrightness
        case "target_temperature": type = HMCharacteristicTypeTargetTemperature
        case "target_position": type = HMCharacteristicTypeTargetPosition
        default: throw PhoneCallError("`property` must be power, brightness, target_temperature or target_position.")
        }
        guard let characteristic = accessory.services.flatMap(\.characteristics).first(where: { $0.characteristicType == type }),
              characteristic.properties.contains(HMCharacteristicPropertyWritable) else {
            throw PhoneCallError("\(accessory.name) can't be set that way (no writable \(property.replacingOccurrences(of: "_", with: " "))). Nothing was changed.")
        }
        let value: NSNumber
        if property == "power" {
            guard case .bool(let on)? = args["value"] else { throw PhoneCallError("`value` must be true or false for power.") }
            value = NSNumber(value: on)
        } else {
            guard case .number(let number)? = args["value"] else { throw PhoneCallError("`value` must be a number for \(property).") }
            if let low = characteristic.metadata?.minimumValue?.doubleValue, let high = characteristic.metadata?.maximumValue?.doubleValue, number < low || number > high {
                throw PhoneCallError("\(accessory.name) accepts \(property.replacingOccurrences(of: "_", with: " ")) from \(low) to \(high). Nothing was changed.")
            }
            value = property == "target_temperature" ? NSNumber(value: number) : NSNumber(value: Int(number.rounded()))
        }
        do { try await characteristic.writeValue(value) } catch {
            throw PhoneCallError("\(accessory.name) did not accept that: \(error.localizedDescription). It may or may not have changed.")
        }
        return .object(["accessory": .string(accessory.name), "room": .string(accessory.room?.name ?? ""), "property": .string(property), "value": args["value"] ?? .null])
    }
}
