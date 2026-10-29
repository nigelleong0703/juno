import SwiftUI

/// The native form for a `secure_input` request: the secrets a page asks for (card, password, code)
/// are encrypted on this phone to the computer's key and go to the page through the server. Values live only in this
/// sheet's @State and are cleared when the sheet closes (never before the server took them). Typed fields (keyboards, text content types, formatting,
/// validation) let iOS fill them; card details the user chose to keep come from the Keychain vault after Face ID.
/// (Name, email, phone and address are the account profile: the agent fills those itself, never through this sheet.)
struct SecureInputSheet: View {
    @Environment(World.self) private var world
    @Environment(\.dismiss) private var dismiss
    var requestId: String

    @State private var values: [String: String] = [:]
    /// The sealed values, held only while the user has the screen (409 USER_CONTROL): sent again once it is handed back.
    @State private var held: [String: Contract.SealedSecureValue]?
    /// Details to keep once the page took the values (never a CVC or a one-time code): label, kind and value.
    @State private var toSave: [(label: String, kind: String, value: String)] = []
    /// The vault entry a field was filled from: saving again replaces it instead of adding a copy.
    @State private var filledFrom: [String: String] = [:]
    @State private var labels: [String: String] = [:]
    /// Fields filled from the vault: shown masked until revealed.
    @State private var vaultFilled: Set<String> = []
    @State private var saveFlags: [String: Bool] = [:]
    @State private var revealed: Set<String> = []
    @State private var touched: Set<String> = []
    @State private var busy = false
    @State private var message: String?
    @State private var needsHandBack = false
    var body: some View {
        let request = world.request(requestId)
        let fields = request?.payload?.fields ?? []
        let name = world.agent(request?.agentId)?.name ?? "Your agent"
        let ready = !fields.isEmpty && fields.allSatisfy { SecureKind.validate($0, values[$0.id] ?? "") == nil && (!saves($0) || SecureVault.labelProblem(label($0)) == nil) }
        JunoSheet(icon: "lock",
                  title: fields.count == 1 ? (fields[0].label ?? "Secure input") : (request?.secretNoun == "card details" ? "Card details" : "Secure input"),
                  guidance: request?.payload?.reason ?? request?.summary,
                  note: "End-to-end encrypted — only your computer can read this.",
                  primary: busy ? "Sending…" : "Submit", primaryEnabled: ready, loading: busy, long: fields.count > 3, id: "secure",
                  onPrimary: { Task { await submit(fields) } }, onCancel: { dismiss() }) {
            if let message {
                JunoMessage(text: message, id: "secure-message") {
                    if needsHandBack {
                        Button("Return the screen to \(name)") { Task { await handBackAndRetry(request?.agentId) } }
                            .buttonStyle(WebButton(variant: .secondary, size: .regular))
                    }
                }
            }
            ForEach(fields) { field in
                JunoFormField(label: field.label ?? field.prompt ?? "Value", optional: !field.isRequired,
                              help: field.help, error: error(field)) {
                    row(field)
                    saveToggle(field)
                }
                .disabled(busy)
            }
        }
        .task { await prefillFromVault(fields) }
        .onDisappear { values = [:]; held = nil; toSave = [] }
    }

    // MARK: Rows

    private func binding(_ field: QuestionField) -> Binding<String> {
        Binding(get: { values[field.id] ?? "" }, set: { new in
            let clean = SecureKind.sanitize(field, new)
            guard values[field.id] != clean else { return }
            values[field.id] = clean; touched.insert(field.id); message = nil
        })
    }

    private func error(_ field: QuestionField) -> String? {
        if touched.contains(field.id), let error = SecureKind.validate(field, values[field.id] ?? "") { return error }
        if field.status == "failed" { return "Could not fill this field" }
        return nil
    }

    @ViewBuilder private func row(_ field: QuestionField) -> some View {
        let kind = SecureKind.resolve(field)
        let bound = binding(field)
        if let options = field.options, !options.isEmpty {
            picker(bound, options: options, id: field.id)
        } else {
            switch kind {
            case "month": picker(bound, options: (1...12).map { String(format: "%02d", $0) }, id: field.id)
            case "year":
                let year = Calendar.current.component(.year, from: Date())
                picker(bound, options: (year...(year + 15)).map(String.init), id: field.id)
            case "country": CountryRow(selection: bound, id: field.id)
            default: input(field, kind: kind, bound: bound)
            }
        }
    }

    private func picker(_ selection: Binding<String>, options: [String], id: String) -> some View {
        JunoPickerRow(value: selection.wrappedValue, options: options, noneLabel: "None", id: "secure-field-\(id)") { selection.wrappedValue = $0 }
    }

    private func input(_ field: QuestionField, kind: String, bound: Binding<String>) -> some View {
        let secret = ["password", "card_cvc", "otp"].contains(kind) || vaultFilled.contains(field.id)
        let shown = revealed.contains(field.id)
        return HStack {
            Group {
                if secret && !shown { SecureField(field.placeholder ?? "", text: bound) }
                else { TextField(field.placeholder ?? SecureKind.placeholder(kind), text: bound) }
            }
            .keyboardType(SecureKind.keyboard(kind))
            .textContentType(SecureKind.contentType(kind))
            .textInputAutocapitalization(SecureKind.capitalization(kind))
            .autocorrectionDisabled()
            .accessibilityIdentifier("secure-field-\(field.id)")
            if kind == "password" || vaultFilled.contains(field.id) {
                Button { if shown { revealed.remove(field.id) } else { revealed.insert(field.id) } } label: {
                    Image(systemName: shown ? "eye.slash" : "eye").text(.md).foregroundStyle(Theme.fgMuted)
                }
                .buttonStyle(.plain).accessibilityLabel(shown ? "Hide" : "Show")
            }
        }
        .inputField()
    }

    // MARK: Sending

    private func submit(_ fields: [QuestionField]) async {
        if let held { await send(held, fields: fields); return }
        var sent: [String: String] = [:]
        var keep: [(label: String, kind: String, value: String)] = []
        for field in fields {
            let value = SecureKind.output(field, values[field.id] ?? "")
            guard !value.isEmpty else { continue }
            sent[field.id] = value
            if saves(field), let kind = vaultKind(field) { keep.append((label(field), kind, value)) }
        }
        do {
            let sealed = try world.sealSecureInput(requestId, values: sent)
            toSave = keep
            await send(sealed, fields: fields)
        } catch { message = error.localizedDescription }
    }

    private func send(_ sealed: [String: Contract.SealedSecureValue], fields: [QuestionField]) async {
        busy = true; message = nil; needsHandBack = false
        defer { busy = false }
        do {
            let results = try await world.submitSecureInput(requestId, sealed: sealed)
            held = nil
            let failed = results.filter { $0.status == "failed" }
            if failed.isEmpty { saveToVaultAndClose(); return }
            message = failed.map { f in "Could not fill \(fields.first { $0.id == f.id }?.label ?? f.id)." }.joined(separator: " ")
        } catch let APIError.api(status, code, _) where status == 409 && code == "USER_CONTROL" {
            held = sealed
            needsHandBack = true
            message = "You still have control of the screen. Hand it back, then try again."
        } catch let APIError.api(status, code, _) where status == 409 && code == "ENCRYPTION_UNAVAILABLE" {
            message = SecureSeal.Failure.olderComputer.localizedDescription
        } catch {
            message = error.localizedDescription
        }
    }

    // MARK: Vault

    private func kind(_ field: QuestionField) -> String { SecureKind.resolve(field) }
    private func vaultKind(_ field: QuestionField) -> String? { SecureVault.kind(for: field, fieldKind: kind(field)) }
    private func canSave(_ field: QuestionField) -> Bool { vaultKind(field) != nil }
    /// Off until the user switches it on: nothing is kept unless they say so (a password included).
    private func saves(_ field: QuestionField) -> Bool { canSave(field) && saveFlags[field.id] == true }
    private func label(_ field: QuestionField) -> String {
        labels[field.id] ?? SecureVault.defaultLabel(for: field, site: world.request(requestId)?.payload?.site)
    }

    @ViewBuilder private func saveToggle(_ field: QuestionField) -> some View {
        if canSave(field) {
            Toggle(isOn: Binding(get: { saves(field) }, set: { saveFlags[field.id] = $0 })) {
                Text("Save on this iPhone").text(.xs).foregroundStyle(Theme.fgMuted)
            }
            .toggleStyle(.switch).tint(Theme.fg).scaleEffect(0.8, anchor: .trailing)
            .accessibilityIdentifier("secure-save-\(field.id)")
            if saves(field) {
                VStack(alignment: .leading, spacing: 4) {
                    TextField("Name", text: Binding(get: { label(field) }, set: { labels[field.id] = $0 }))
                        .text(.base).padding(.horizontal, 12).frame(minHeight: 40)
                        .background(Theme.inputBg, in: .rect(cornerRadius: Radius.md))
                        .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(Theme.border, lineWidth: 1))
                        .accessibilityIdentifier("secure-save-label-\(field.id)")
                    if let problem = SecureVault.labelProblem(label(field)) { Text(problem).text(.xs).foregroundStyle(Theme.danger) }
                    else if field.kind == "password" { Text("Filled in after Face ID. Only the name goes to your computer.").text(.xs).foregroundStyle(Theme.fgMuted) }
                }
            }
        }
    }

    /// Fills fields whose `vaultId` names an entry this phone holds, after Face ID / passcode once for the sheet.
    private func prefillFromVault(_ fields: [QuestionField]) async {
        let held = Set(SecureVault.entries().map(\.id))
        let matches = fields.filter { canSave($0) && $0.vaultId.map(held.contains) == true }
        guard !matches.isEmpty, await SecureVault.unlock() else { return }
        for field in matches {
            guard values[field.id] == nil, let id = field.vaultId, let saved = SecureVault.value(id) else { continue }
            if let options = field.options, !options.isEmpty, !options.contains(saved) { continue }
            values[field.id] = SecureKind.sanitize(field, saved)
            vaultFilled.insert(field.id)
            filledFrom[field.id] = id
        }
    }

    private func saveToVaultAndClose() {
        let keep = toSave
        toSave = []
        if !keep.isEmpty {
            for item in keep {
                // The same value filled from an entry stays that entry (new label if edited); anything else is a new entry.
                let existing = filledFrom.values.first { SecureVault.value($0) == item.value }
                SecureVault.save(item.value, label: item.label, kind: item.kind, id: existing ?? UUID().uuidString)
            }
            world.syncVaultKeys()
        }
        dismiss()
    }

    private func handBackAndRetry(_ agentId: String?) async {
        world.setController("agent", agentId: agentId)
        try? await Task.sleep(for: .milliseconds(900))
        guard let held else { return }
        await send(held, fields: world.request(requestId)?.payload?.fields ?? [])
    }
}

/// A country row that opens a searchable list of the regions iOS knows; the chosen name is the value.
private struct CountryRow: View {
    @Binding var selection: String
    var id: String
    @State private var open = false

    var body: some View {
        JunoPickerRow(value: selection, id: "secure-field-\(id)") { open = true }
            .sheet(isPresented: $open) { CountryList(selection: $selection).junoSheetPresentation(long: true) }
    }
}

private struct CountryList: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var selection: String
    @State private var query = ""

    private static let names: [String] = {
        let locale = Locale.current
        return Locale.Region.isoRegions.filter { $0.subRegions.isEmpty && $0.identifier.count == 2 }
            .compactMap { locale.localizedString(forRegionCode: $0.identifier) }
            .sorted { $0.localizedCompare($1) == .orderedAscending }
    }()

    var body: some View {
        let shown = query.isEmpty ? Self.names : Self.names.filter { $0.localizedCaseInsensitiveContains(query) }
        NavigationStack {
            List(shown, id: \.self) { name in
                Button { selection = name; dismiss() } label: {
                    HStack {
                        Text(name).text(.lg).foregroundStyle(Theme.fg)
                        Spacer()
                        if name == selection { Image(systemName: "checkmark").foregroundStyle(Theme.fg) }
                    }
                }
                .listRowBackground(Theme.muted)
            }
            .webGrouped()
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always))
            .pageHeader("Country")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .tint(Theme.fg)
    }
}

// MARK: - Kinds

/// Secure-input field kinds. Older requests label everything `text`; the label then says what it really is.
enum SecureKind {
    static func resolve(_ field: QuestionField) -> String {
        let kind = field.kind ?? "text"
        guard kind == "text" else { return kind }
        let label = (field.label ?? field.prompt ?? "").lowercased()
        let table: [(String, [String])] = [
            ("month", ["月份", "month"]), ("year", ["年份", "year"]), ("country", ["国家", "country"]),
            ("city", ["城市", "city"]), ("email", ["邮箱", "邮件", "email", "e-mail"]), ("phone", ["电话", "手机", "phone", "mobile"]),
            ("postal_code", ["邮编", "zip", "postal", "postcode"]), ("name", ["姓名", "名字", "name"]),
            ("address", ["地址", "address"]),
        ]
        return table.first { _, words in words.contains { label.contains($0) } }?.0 ?? "text"
    }

    static func keyboard(_ kind: String) -> UIKeyboardType {
        switch kind {
        case "card_number", "card_expiry", "card_cvc", "otp": .numberPad
        case "email": .emailAddress
        case "phone": .phonePad
        case "number": .decimalPad
        case "postal_code": .numbersAndPunctuation
        default: .default
        }
    }

    static func contentType(_ kind: String) -> UITextContentType? {
        switch kind {
        case "password": .password
        case "card_number": .creditCardNumber
        case "card_expiry": .creditCardExpiration
        case "card_cvc": .creditCardSecurityCode
        case "otp": .oneTimeCode
        case "name": .name
        case "email": .emailAddress
        case "phone": .telephoneNumber
        case "address": .fullStreetAddress
        case "city": .addressCity
        case "postal_code": .postalCode
        default: nil
        }
    }

    static func capitalization(_ kind: String) -> TextInputAutocapitalization {
        switch kind {
        case "name", "address", "city": .words
        case "postal_code": .characters
        case "text": .sentences
        default: .never
        }
    }

    static func placeholder(_ kind: String) -> String {
        switch kind {
        case "card_number": "1234 5678 9012 3456"
        case "card_expiry": "MM/YY"
        case "email": "name@example.com"
        default: ""
        }
    }

    private static func digits(_ s: String) -> String { s.filter { $0.isASCII && $0.isNumber } }

    /// What may be typed, formatted as it should look: cards in 4s, expiry as MM/YY, codes as digits.
    static func sanitize(_ field: QuestionField, _ raw: String) -> String {
        var s = raw
        switch resolve(field) {
        case "card_number":
            let d = String(digits(s).prefix(19))
            s = stride(from: 0, to: d.count, by: 4).map { i in String(d.dropFirst(i).prefix(4)) }.joined(separator: " ")
        case "card_expiry":
            let d = String(digits(s).prefix(4))
            s = d.count > 2 ? d.prefix(2) + "/" + d.dropFirst(2) : d
        case "card_cvc": s = String(digits(s).prefix(4))
        case "otp": s = String(digits(s).prefix(10))
        case "number":
            var out = "", dot = false
            for ch in s {
                if ch.isASCII, ch.isNumber { out.append(ch) }
                else if ch == "." || ch == ",", !dot { dot = true; out.append(".") }
                else if ch == "-", out.isEmpty { out.append(ch) }
            }
            s = out
        case "postal_code": s = s.uppercased()
        default: break
        }
        if let limit = field.maxLength, limit > 0, s.count > limit { s = String(s.prefix(limit)) }
        return s
    }

    /// The text that goes to the page: card numbers without spaces, everything trimmed.
    static func output(_ field: QuestionField, _ value: String) -> String {
        let v = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return resolve(field) == "card_number" ? v.replacingOccurrences(of: " ", with: "") : v
    }

    /// nil when fine (or optional and empty). The rules and messages are `validateSecureInputValues` in the public contracts,
    /// which no longer runs on the server: the server only ever sees ciphertext.
    static func validate(_ field: QuestionField, _ raw: String) -> String? {
        let v = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if v.isEmpty { return field.isRequired ? "Required" : nil }
        let d = digits(v)
        switch resolve(field) {
        case "card_number":
            return (12...19).contains(d.count) && luhn(d) ? nil : "Enter a valid card number"
        case "card_expiry":
            guard d.count == 4, let m = Int(d.prefix(2)), let y = Int(d.suffix(2)), (1...12).contains(m) else { return "Enter the expiry as MM/YY" }
            let now = Calendar.current.dateComponents([.year, .month], from: Date())
            let thisYear = (now.year ?? 2000) % 100
            return y > thisYear || (y == thisYear && m >= (now.month ?? 1)) ? nil : "This card has expired"
        case "card_cvc": return (3...4).contains(d.count) ? nil : "Enter the 3 or 4 digit security code"
        case "otp": return (4...10).contains(d.count) ? nil : "Enter the digits of the code"
        case "email": return v.range(of: #"^[^@\s]+@[^@\s]+\.[^@\s]+$"#, options: .regularExpression) == nil ? "Enter a valid email address" : nil
        case "phone":
            return v.range(of: #"^\+?[\d\s().-]{5,24}$"#, options: .regularExpression) != nil && d.count >= 5 ? nil : "Enter a valid phone number"
        case "number":
            guard let n = Double(v) else { return "Enter a number" }
            if let lo = field.min?.number, n < lo { return "Must be at least \(lo)" }
            if let hi = field.max?.number, n > hi { return "Must be at most \(hi)" }
            return nil
        case "date": return QuestionAnswers.parseDate(v, .date) == nil ? "Enter a date as YYYY-MM-DD" : nil
        default: return nil
        }
    }

    static func luhn(_ digits: String) -> Bool {
        var sum = 0
        for (i, ch) in digits.reversed().enumerated() {
            guard var n = ch.wholeNumberValue else { return false }
            if i % 2 == 1 { n *= 2; if n > 9 { n -= 9 } }
            sum += n
        }
        return sum % 10 == 0
    }
}
