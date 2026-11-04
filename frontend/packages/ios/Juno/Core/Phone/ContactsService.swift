import Contacts
import Foundation

/// Contacts through the Contacts framework, for the agent (backend BACKEND 7.13b). Search by name, phone number or email; add a
/// contact, or a phone number or email to one. With limited access (the owner picked some contacts) only those, and the ones Juno
/// itself added, can be found or changed. Notes are never read or written: they need an entitlement Apple has to grant.
@MainActor struct ContactsSystem: PhoneSystem {
    private let service = ContactsService()

    var access: PhoneAccess {
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized: .full
        case .limited: .limited
        case .notDetermined: .notAsked
        case .restricted: .unavailable
        default: .denied
        }
    }

    func request() async { await service.request() }
    func actions(for access: PhoneAccess) -> [String] { access.usable ? ["contacts.read", "contacts.write"] : [] }
    func changes(_ action: String) -> Bool { action == "contacts.create" || action == "contacts.add_detail" }

    func run(_ action: String, _ args: [String: JSONValue]) async throws -> JSONValue {
        switch action {
        case "contacts.search": return try await service.search(args, limited: access == .limited)
        case "contacts.create": return try await service.create(args)
        case "contacts.add_detail": return try await service.addDetail(args)
        default: throw PhoneCallError("This version of Juno on the iPhone does not know \(action).")
        }
    }
}

actor ContactsService {
    private let store = CNContactStore()

    func request() async {
        _ = try? await store.requestAccess(for: .contacts)
    }

    private var keys: [CNKeyDescriptor] {
        [CNContactFormatter.descriptorForRequiredKeys(for: .fullName), CNContactIdentifierKey as CNKeyDescriptor, CNContactOrganizationNameKey as CNKeyDescriptor,
         CNContactPhoneNumbersKey as CNKeyDescriptor, CNContactEmailAddressesKey as CNKeyDescriptor]
    }

    func search(_ args: [String: JSONValue], limited: Bool) throws -> JSONValue {
        let query = try args.requiredString("query").trimmingCharacters(in: .whitespacesAndNewlines)
        let limit = min(args.int("limit") ?? 10, 20)
        let predicate: NSPredicate
        if query.contains("@") {
            predicate = CNContact.predicateForContacts(matchingEmailAddress: query)
        } else if Self.looksLikePhoneNumber(query) {
            predicate = CNContact.predicateForContacts(matching: CNPhoneNumber(stringValue: query))
        } else {
            predicate = CNContact.predicateForContacts(matchingName: query)
        }
        let found = try store.unifiedContacts(matching: predicate, keysToFetch: keys)
        var out: [String: JSONValue] = ["matches": .array(found.prefix(limit).map(Self.json))]
        if found.count > limit { out["more"] = .string("\(found.count - limit) more matched; search for something narrower.") }
        if limited && found.isEmpty { out["note"] = .string("Juno can see only the contacts the owner chose (and the ones it added), so the person may be in Contacts but not shared with Juno.") }
        return .object(out)
    }

    func create(_ args: [String: JSONValue]) throws -> JSONValue {
        let contact = CNMutableContact()
        contact.givenName = args.string("givenName") ?? ""
        contact.familyName = args.string("familyName") ?? ""
        contact.organizationName = args.string("organization") ?? ""
        guard !(contact.givenName + contact.familyName + contact.organizationName).isEmpty else { throw PhoneCallError("A name or an organization is needed.") }
        contact.phoneNumbers = args.strings("phones").map { CNLabeledValue(label: CNLabelPhoneNumberMobile, value: CNPhoneNumber(stringValue: $0)) }
        contact.emailAddresses = args.strings("emails").map { CNLabeledValue(label: CNLabelOther, value: $0 as NSString) }
        let request = CNSaveRequest()
        request.add(contact, toContainerWithIdentifier: nil)
        try store.execute(request)
        return Self.json(contact)
    }

    func addDetail(_ args: [String: JSONValue]) throws -> JSONValue {
        let id = try args.requiredString("id")
        let phone = args.string("phone"), email = args.string("email")
        guard phone != nil || email != nil else { throw PhoneCallError("A phone or an email is needed.") }
        let found = try store.unifiedContacts(matching: CNContact.predicateForContacts(withIdentifiers: [id]), keysToFetch: keys)
        guard let contact = found.first?.mutableCopy() as? CNMutableContact else {
            throw PhoneCallError("No contact with that id. It may be one the owner did not share with Juno. Search again with phone_contacts_search.")
        }
        var added: [String] = []
        if let phone {
            let digits = Self.digits(phone)
            if !contact.phoneNumbers.contains(where: { Self.digits($0.value.stringValue) == digits }) {
                contact.phoneNumbers.append(CNLabeledValue(label: CNLabelPhoneNumberMobile, value: CNPhoneNumber(stringValue: phone)))
                added.append("phone")
            }
        }
        if let email {
            if !contact.emailAddresses.contains(where: { ($0.value as String).caseInsensitiveCompare(email) == .orderedSame }) {
                contact.emailAddresses.append(CNLabeledValue(label: CNLabelOther, value: email as NSString))
                added.append("email")
            }
        }
        guard !added.isEmpty else { return .object(["unchanged": .bool(true), "contact": Self.json(contact)]) }
        let request = CNSaveRequest()
        request.update(contact)
        try store.execute(request)
        return .object(["added": .array(added.map(JSONValue.string)), "contact": Self.json(contact)])
    }

    // MARK: Words

    /// Mostly digits (with the usual +, spaces, dashes and brackets) and long enough to be a number, not a name.
    private static func looksLikePhoneNumber(_ text: String) -> Bool {
        let allowed = CharacterSet(charactersIn: "+-() .0123456789")
        return text.unicodeScalars.allSatisfy(allowed.contains) && digits(text).count >= 5
    }

    private static func digits(_ text: String) -> String { text.filter(\.isNumber) }

    private static func json(_ contact: CNContact) -> JSONValue {
        let name = CNContactFormatter.string(from: contact, style: .fullName) ?? contact.organizationName
        var out: [String: JSONValue] = ["id": .string(contact.identifier), "name": .string(name)]
        if !contact.organizationName.isEmpty, contact.organizationName != name { out["organization"] = .string(contact.organizationName) }
        out["phones"] = .array(contact.phoneNumbers.map { .object(["label": .string(label($0.label)), "number": .string($0.value.stringValue)]) })
        out["emails"] = .array(contact.emailAddresses.map { .object(["label": .string(label($0.label)), "value": .string($0.value as String)]) })
        return .object(out)
    }

    private static func label(_ raw: String?) -> String { raw.map { CNLabeledValue<NSString>.localizedString(forLabel: $0) } ?? "" }
}
