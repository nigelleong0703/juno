import Foundation
import LocalAuthentication
import Security

/// One thing the user chose to keep on this iPhone: a label they can read ("Visa ending 4242", "Apple ID password") and a
/// kind. The value is only ever in the Keychain.
struct VaultEntry: Identifiable, Hashable {
    var id: String
    var label: String
    /// card / password / other (the contract also has code, which is never saved here).
    var kind: String
    var kindWord: String { kind == "card" ? "Card detail" : kind == "password" ? "Password" : "Detail" }
}

/// Details the user chose to keep for next time (card number, expiry, cardholder name, a website password). Values live
/// only in this iPhone's Keychain, one item per entry (account = the entry id, label and kind as item attributes); the
/// server learns just the id, label and kind (`PUT /v1/secure-vault/keys`) and the agent maps form fields to them.
/// Name, email, phone and address are the account profile instead. Security codes (CVC) and one-time codes are never
/// saved. A password is saved only when the user switches the toggle on (it is off by default) and is filled in after Face ID.
enum SecureVault {
    static let service = "io.github.nigelleong0703.juno.vault"

    /// The server refuses these in a label; so does the app, before anything is saved.
    private static let blockedLabel = #"(?i)\b(cvc|cvv|cid|csc|2fa|otp|authenticator)\b|security code|verification code|one-time"#
    static func labelProblem(_ label: String) -> String? {
        let t = label.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return "Give it a name" }
        if t.count > 60 { return "At most 60 characters" }
        if t.range(of: blockedLabel, options: .regularExpression) != nil { return "Security and one-time codes are never saved" }
        return nil
    }

    private static func query(_ id: String? = nil) -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        if let id { q[kSecAttrAccount as String] = id }
        return q
    }

    static func value(_ id: String) -> String? {
        var q = query(id)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Saves (or replaces) an entry and returns its id; nil when the label or value is not acceptable.
    @discardableResult
    static func save(_ value: String, label: String, kind: String, id: String = UUID().uuidString) -> String? {
        let label = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard labelProblem(label) == nil, !value.isEmpty, ["card", "password", "other"].contains(kind) else { return nil }
        let data = Data(value.utf8)
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrLabel as String: label, kSecAttrDescription as String: kind]
        if SecItemUpdate(query(id) as CFDictionary, attributes as CFDictionary) == errSecSuccess { return id }
        var add = query(id).merging(attributes) { $1 }
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess ? id : nil
    }

    static func delete(_ id: String) { SecItemDelete(query(id) as CFDictionary) }

    /// The saved entries, by label. Items without a label or kind (from an older build) are ignored.
    static func entries() -> [VaultEntry] {
        var q = query()
        q[kSecReturnAttributes as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitAll
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let rows = out as? [[String: Any]] else { return [] }
        return rows.compactMap { row in
            guard let id = row[kSecAttrAccount as String] as? String, let label = row[kSecAttrLabel as String] as? String,
                  let kind = row[kSecAttrDescription as String] as? String, ["card", "password", "other"].contains(kind) else { return nil }
            return VaultEntry(id: id, label: label, kind: kind)
        }
        .sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
    }

    /// Face ID / passcode, asked once per sheet before any saved value is shown. A phone with no passcode cannot ask: the
    /// Keychain already holds nothing more protected than the phone itself, so it proceeds.
    static func unlock() async -> Bool {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { return true }
        return (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Fill in your saved details")) ?? false
    }

    // MARK: What a field can be saved as

    /// The kind an entry saved from this field gets, or nil when the field is never offered for saving (security codes,
    /// one-time codes, and the profile's name / email / phone / address).
    static func kind(for field: QuestionField, fieldKind: String) -> String? {
        switch fieldKind {
        case "card_number", "card_expiry": return "card"
        case "password": return "password"
        case "name":
            let label = (field.label ?? field.prompt ?? "").lowercased()
            return ["card", "holder", "持卡"].contains { label.contains($0) } ? "card" : nil
        default: return nil
        }
    }

    /// A first label for the "Save on this iPhone" switch: the field's own label, with the site for a password.
    static func defaultLabel(for field: QuestionField, site: String?) -> String {
        let base = field.label ?? field.prompt ?? "Saved detail"
        guard field.kind == "password", let site, !site.isEmpty, !base.localizedCaseInsensitiveContains(site) else { return base }
        return "\(site) \(base.lowercased())"
    }
}
