import SwiftUI

// Typed validation and formatting for secure-input fields (the question card uses UiDoc / UiAnswers).

enum QuestionInputKind { case text, longText, number, date, time, datetime, choice, multiChoice, email, url, phone }

extension QuestionField {
    /// Unknown kinds fall back to a text field (or a choice when options come with them).
    var inputKind: QuestionInputKind {
        switch kind {
        case "long_text": .longText
        case "number": .number
        case "date": .date
        case "time": .time
        case "datetime": .datetime
        case "choice": (options ?? []).isEmpty ? .text : .choice
        case "multi_choice": (options ?? []).isEmpty ? .text : .multiChoice
        case "email": .email
        case "url": .url
        case "phone": .phone
        default: kind == nil && !(options ?? []).isEmpty ? .choice : .text
        }
    }
    var isRequired: Bool { required != false }
}

enum QuestionAnswers {
    // MARK: Typing

    static func keyboard(_ field: QuestionField) -> UIKeyboardType {
        switch field.inputKind {
        case .number:
            if allowsNegative(field) { return .numbersAndPunctuation }
            return isIntegerStep(field) ? .numberPad : .decimalPad
        case .email: return .emailAddress
        case .url: return .URL
        case .phone: return .phonePad
        default: return .default
        }
    }

    static func contentType(_ kind: QuestionInputKind) -> UITextContentType? {
        switch kind { case .email: .emailAddress; case .url: .URL; case .phone: .telephoneNumber; default: nil }
    }

    /// What may be typed: numbers keep digits, one decimal point and a leading minus; everything keeps maxLength.
    static func sanitize(_ field: QuestionField, _ raw: String) -> String {
        var s = raw
        if field.inputKind == .number {
            let decimal = !isIntegerStep(field), negative = allowsNegative(field)
            var out = "", dot = false
            for ch in s {
                if ch.isASCII, ch.isNumber { out.append(ch) }
                else if (ch == "." || ch == ","), decimal, !dot { dot = true; out.append(".") }
                else if ch == "-", negative, out.isEmpty { out.append(ch) }
            }
            s = out
        }
        if let limit = field.maxLength, limit > 0, s.count > limit { s = String(s.prefix(limit)) }
        return s
    }

    static func isIntegerStep(_ field: QuestionField) -> Bool {
        guard let step = field.step?.number else { return false }
        return step >= 1 && step == step.rounded()
    }
    static func allowsNegative(_ field: QuestionField) -> Bool { (field.min?.number ?? -1) < 0 }

    // MARK: Validation (nil = fine)

    static func validate(_ field: QuestionField, _ raw: String) -> String? {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return field.isRequired ? "Required" : nil }
        switch field.inputKind {
        case .number: return validateNumber(field, value)
        case .email:
            return value.range(of: #"^[^@\s]+@[^@\s]+\.[^@\s]+$"#, options: .regularExpression) == nil ? "Enter a valid email address" : nil
        case .url:
            return URL(string: normalizedURL(value))?.host?.contains(".") == true ? nil : "Enter a valid web address"
        case .phone:
            let digits = value.filter(\.isNumber).count
            let allowed = value.allSatisfy { $0.isNumber || "+-(). ".contains($0) }
            return allowed && (7...15).contains(digits) ? nil : "Enter a valid phone number"
        case .date, .time, .datetime:
            let kind = field.inputKind
            guard let date = parseDate(value, kind) else { return "Pick a value" }
            return validateDate(field, date, kind)
        case .choice: return (field.options ?? []).contains(value) ? nil : "Pick one"
        case .multiChoice: return decodeList(value).isEmpty ? (field.isRequired ? "Pick at least one" : nil) : nil
        case .text, .longText: return nil
        }
    }

    private static func validateNumber(_ field: QuestionField, _ value: String) -> String? {
        guard let n = Double(value) else { return "Enter a number" }
        if let lo = field.min?.number, n < lo { return "Must be at least \(num(lo))" }
        if let hi = field.max?.number, n > hi { return "Must be at most \(num(hi))" }
        if let step = field.step?.number, step > 0 {
            let q = (n - (field.min?.number ?? 0)) / step
            if abs(q - q.rounded()) > 1e-6 { return "Must be a multiple of \(num(step))" }
        }
        return nil
    }

    private static func validateDate(_ field: QuestionField, _ date: Date, _ kind: QuestionInputKind) -> String? {
        if let lo = bound(field.min, kind), compare(date, lo, kind) < 0 { return "Must be \(formatDate(lo, kind)) or later" }
        if let hi = bound(field.max, kind), compare(date, hi, kind) > 0 { return "Must be \(formatDate(hi, kind)) or earlier" }
        return nil
    }

    /// Dates compare by day, times by minute of day, date-times exactly.
    private static func compare(_ a: Date, _ b: Date, _ kind: QuestionInputKind) -> Int {
        let sa = kind == .datetime ? "\(a.timeIntervalSince1970)" : formatDate(a, kind)
        let sb = kind == .datetime ? "\(b.timeIntervalSince1970)" : formatDate(b, kind)
        if kind == .datetime { return a < b ? -1 : a > b ? 1 : 0 }
        return sa < sb ? -1 : sa > sb ? 1 : 0
    }

    static func rangeHint(_ field: QuestionField) -> String? {
        switch (field.min?.number, field.max?.number) {
        case let (lo?, hi?): "\(num(lo)) – \(num(hi))"
        case let (lo?, nil): "At least \(num(lo))"
        case let (nil, hi?): "At most \(num(hi))"
        default: nil
        }
    }

    private static func num(_ v: Double) -> String { v == v.rounded() && abs(v) < 1e15 ? String(Int(v)) : String(v) }

    // MARK: Answers

    /// The string sent to the server: a trimmed value, a decimal number, a URL with its scheme.
    static func normalize(_ field: QuestionField, _ raw: String) -> String {
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        switch field.inputKind {
        case .number: if value.hasSuffix(".") { value.removeLast() }
        case .url: if !value.isEmpty { value = normalizedURL(value) }
        default: break
        }
        return value
    }

    private static func normalizedURL(_ value: String) -> String { value.contains("://") ? value : "https://" + value }

    static func decodeList(_ json: String) -> [String] {
        (try? JSONDecoder().decode([String].self, from: Data(json.utf8))) ?? []
    }
    static func encodeList(_ list: [String]) -> String {
        list.isEmpty ? "" : String(data: (try? JSONEncoder().encode(list)) ?? Data(), encoding: .utf8) ?? ""
    }

    // MARK: Dates (date YYYY-MM-DD, time HH:mm, datetime ISO 8601; day and time in the user's time zone)

    private static func formatter(_ format: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = format
        return f
    }
    private static func iso(fractional: Bool) -> ISO8601DateFormatter {
        let f = ISO8601DateFormatter()
        f.formatOptions = fractional ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
        return f
    }

    static func components(_ kind: QuestionInputKind) -> DatePicker.Components {
        switch kind { case .date: .date; case .time: .hourAndMinute; default: [.date, .hourAndMinute] }
    }

    static func formatDate(_ date: Date, _ kind: QuestionInputKind) -> String {
        switch kind {
        case .date: formatter("yyyy-MM-dd").string(from: date)
        case .time: formatter("HH:mm").string(from: date)
        default: iso(fractional: false).string(from: date)
        }
    }

    static func parseDate(_ s: String, _ kind: QuestionInputKind) -> Date? {
        guard !s.isEmpty else { return nil }
        let day = formatter("yyyy-MM-dd"), time = formatter("HH:mm")
        let isoDate = iso(fractional: false).date(from: s) ?? iso(fractional: true).date(from: s)
        switch kind {
        case .date: return day.date(from: String(s.prefix(10))) ?? isoDate
        case .time: return time.date(from: String(s.prefix(5))) ?? isoDate
        default: return isoDate ?? day.date(from: String(s.prefix(10)))
        }
    }

    private static func bound(_ b: FieldBound?, _ kind: QuestionInputKind) -> Date? {
        b?.string.flatMap { parseDate($0, kind) }
    }

    /// The picker's range; a time of day has none (the answer is validated instead).
    static func dateRange(_ field: QuestionField) -> ClosedRange<Date> {
        let kind = field.inputKind
        guard kind != .time else { return .distantPast ... .distantFuture }
        let lo = bound(field.min, kind) ?? .distantPast, hi = bound(field.max, kind) ?? .distantFuture
        return lo <= hi ? lo ... hi : .distantPast ... .distantFuture
    }

    static func clamp(_ date: Date, _ field: QuestionField) -> Date {
        let range = dateRange(field)
        return min(max(date, range.lowerBound), range.upperBound)
    }
}
