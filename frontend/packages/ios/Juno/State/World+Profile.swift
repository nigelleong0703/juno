import Foundation

extension World {
    /// GET /v1/profile: the account's details, one flat list (empty when nothing is saved).
    func loadProfile() async throws -> [Contract.ProfileEntry] {
        guard let api else { throw APIError.notSignedIn }
        return try await api.get("/v1/profile", as: Contract.Profile.self).entries ?? []
    }

    /// PUT /v1/profile replaces the whole list; the server's copy (with sources) comes back.
    func saveProfile(_ entries: [Contract.ProfileEntry]) async throws -> [Contract.ProfileEntry] {
        guard let api else { throw APIError.notSignedIn }
        let body = Contract.PutProfileInput(entries: entries.map { Contract.PutProfileEntry(id: $0.id, key: $0.key, value: $0.value, visibility: $0.visibility ?? "private") })
        return try isoDecoder.decode(Contract.Profile.self, from: try await api.put("/v1/profile", body)).entries ?? []
    }

    /// The owner's time zone setting (`general.timezone` / `timezoneAuto`). Automatic is the default: `reportTimeZone`
    /// keeps the server on this device's zone until a zone is chosen by hand.
    struct TimeZoneSetting: Equatable {
        var zone: String
        var automatic: Bool
    }

    private struct GeneralSettings: Codable {
        struct General: Codable { var timezone: String?; var timezoneAuto: Bool? }
        var general: General?
    }

    /// GET /v1/settings, reduced to the time zone shown in Settings → Your details.
    func loadTimeZone() async throws -> TimeZoneSetting {
        guard let api else { throw APIError.notSignedIn }
        let general = try await api.get("/v1/settings", as: GeneralSettings.self).general
        return TimeZoneSetting(zone: general?.timezone ?? TimeZone.current.identifier, automatic: general?.timezoneAuto != false)
    }

    /// PATCH /v1/settings. A chosen zone is sent with `timezoneAuto: false`; switching back to automatic sends this device's zone.
    func saveTimeZone(_ setting: TimeZoneSetting) async throws {
        guard let api else { throw APIError.notSignedIn }
        try await api.patch("/v1/settings", GeneralSettings(general: .init(timezone: setting.zone, timezoneAuto: setting.automatic)))
    }
}
