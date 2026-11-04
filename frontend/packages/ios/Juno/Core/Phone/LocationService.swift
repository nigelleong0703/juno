import CoreLocation
import Foundation
import MapKit

/// Where the iPhone is, for the agent (backend BACKEND 7.13b). When In Use only: one fix per call, taken while the app is open,
/// nothing runs in the background and nothing is kept. Approximate by default (`kCLLocationAccuracyReduced`, which works even when
/// the owner allowed precise); precise only when the agent asks AND the system lets Juno have precise location.
@MainActor final class LocationSystem: NSObject, PhoneSystem, CLLocationManagerDelegate {
    private lazy var manager: CLLocationManager = {
        let manager = CLLocationManager()
        manager.delegate = self
        return manager
    }()
    private var fix: CheckedContinuation<CLLocation, Error>?
    private var permission: CheckedContinuation<Void, Never>?

    /// "Allow Once" reverts to not-asked when the app stops being in use, so the switch can look unanswered again later.
    var access: PhoneAccess {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways: .full
        case .notDetermined: .notAsked
        case .restricted: .unavailable
        default: .denied
        }
    }

    func request() async {
        guard manager.authorizationStatus == .notDetermined else { return }
        await withCheckedContinuation { continuation in
            permission = continuation
            manager.requestWhenInUseAuthorization()
        }
    }

    func actions(for access: PhoneAccess) -> [String] { access.usable ? ["location.read"] : [] }
    func changes(_ action: String) -> Bool { false }

    func run(_ action: String, _ args: [String: JSONValue]) async throws -> JSONValue {
        guard action == "location.current" else { throw PhoneCallError("This version of Juno on the iPhone does not know \(action).") }
        guard access.usable else { throw PhoneCallError("Juno isn't allowed to use the location on this iPhone. The owner can switch it on in Juno > Settings > iPhone access.") }
        let allowedPrecise = manager.accuracyAuthorization == .fullAccuracy
        let precise = (args.bool("precise") ?? false) && allowedPrecise
        manager.desiredAccuracy = precise ? kCLLocationAccuracyBest : kCLLocationAccuracyReduced
        let location = try await currentFix()
        var out: [String: JSONValue] = [
            "latitude": .number(location.coordinate.latitude), "longitude": .number(location.coordinate.longitude),
            "accuracyMeters": .number(location.horizontalAccuracy.rounded()), "approximate": .bool(!precise),
            "time": .string(PhoneTime.iso(location.timestamp)),
        ]
        if (args.bool("precise") ?? false) && !allowedPrecise { out["note"] = .string("Precise location is not allowed for Juno on this iPhone, so this is the approximate position.") }
        if let name = await Self.placeName(location, precise: precise) { out["place"] = .string(name) }
        return .object(out)
    }

    /// One fix, or an error the agent can act on after 20 seconds.
    private func currentFix() async throws -> CLLocation {
        guard fix == nil else { throw PhoneCallError("Another location reading is in progress. Try again in a moment.") }
        let timeout = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 20_000_000_000)
            self?.finishFix(.failure(PhoneCallError("The iPhone could not get a location in time (indoors or no signal?). Try again later.")))
        }
        defer { timeout.cancel() }
        return try await withCheckedThrowingContinuation { continuation in
            fix = continuation
            manager.requestLocation()
        }
    }

    private func finishFix(_ result: Result<CLLocation, Error>) {
        guard let pending = fix else { return }
        fix = nil
        pending.resume(with: result)
    }

    /// A city for an approximate fix, a street address for a precise one; nothing when the map has no name for it.
    private static func placeName(_ location: CLLocation, precise: Bool) async -> String? {
        guard let request = MKReverseGeocodingRequest(location: location), let item = try? await request.mapItems.first else { return nil }
        let name = precise ? item.addressRepresentations?.fullAddress(includingRegion: true, singleLine: true) : item.addressRepresentations?.cityWithContext
        return name?.isEmpty == false ? name : nil
    }

    // MARK: CLLocationManagerDelegate (called on the main queue)

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let latest = locations.last else { return }
        Task { @MainActor in self.finishFix(.success(latest)) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let message = (error as? CLError)?.code == .denied ? "Juno isn't allowed to use the location on this iPhone." : "The iPhone could not get a location: \(error.localizedDescription)"
        Task { @MainActor in self.finishFix(.failure(PhoneCallError(message))) }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            guard self.manager.authorizationStatus != .notDetermined, let waiting = self.permission else { return }
            self.permission = nil
            waiting.resume()
        }
    }
}
