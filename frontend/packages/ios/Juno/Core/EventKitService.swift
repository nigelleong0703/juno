import EventKit
import Foundation

/// Calendar and Reminders through EventKit, for the agent (backend BACKEND 7.13). The service only runs what `PhoneDevice`
/// hands it while the app is open; it never reads or writes by itself. Results are plain JSON for the model: ids, titles, times
/// as ISO 8601 with this iPhone's offset, short notes.
struct PhoneCallError: Error, Sendable {
    var message: String
    init(_ message: String) { self.message = message }
}

/// How far the owner has let Juno into one of the two stores.
enum PhoneAccess: Equatable, Sendable {
    case notAsked, full, writeOnly, denied

    init(_ status: EKAuthorizationStatus) {
        switch status {
        case .fullAccess: self = .full
        case .writeOnly: self = .writeOnly
        case .notDetermined: self = .notAsked
        default: self = .denied
        }
    }
}

actor EventKitService {
    private let store = EKEventStore()

    // MARK: Authorization

    nonisolated static func calendarAccess() -> PhoneAccess { PhoneAccess(EKEventStore.authorizationStatus(for: .event)) }
    nonisolated static func remindersAccess() -> PhoneAccess { PhoneAccess(EKEventStore.authorizationStatus(for: .reminder)) }

    /// What the app may declare to the server: only what is authorized (write-only calendar access can add, not read).
    nonisolated static func declaredActions() -> [String] {
        var actions: [String] = []
        switch calendarAccess() {
        case .full: actions += ["calendar.read", "calendar.write"]
        case .writeOnly: actions += ["calendar.write"]
        default: break
        }
        if remindersAccess() == .full { actions += ["reminders.read", "reminders.write"] }
        return actions
    }

    func requestCalendar() async {
        _ = try? await store.requestFullAccessToEvents()
    }

    func requestReminders() async {
        _ = try? await store.requestFullAccessToReminders()
    }

    // MARK: Calls

    /// Runs one call from the server. Throws `PhoneCallError` with a sentence the agent can act on.
    func run(_ action: String, _ args: [String: JSONValue]) async throws -> JSONValue {
        switch action {
        case "calendar.list_calendars": return try listCalendars()
        case "calendar.list_events": return try listEvents(args)
        case "calendar.create_event": return try createEvent(args)
        case "calendar.update_event": return try updateEvent(args)
        case "calendar.delete_event": return try deleteEvent(args)
        case "reminders.list": return try await listReminders(args)
        case "reminders.create": return try createReminder(args)
        case "reminders.update": return try updateReminder(args)
        case "reminders.delete": return try deleteReminder(args)
        default: throw PhoneCallError("This version of Juno on the iPhone does not know \(action).")
        }
    }

    // MARK: Calendar

    private func requireCalendar(read: Bool) throws {
        switch Self.calendarAccess() {
        case .full: return
        case .writeOnly where !read: return
        case .writeOnly: throw PhoneCallError("Juno only has add-only access to the calendar, so it can't read it. The owner can allow full access in iPhone Settings > Juno > Calendars.")
        default: throw PhoneCallError("Juno isn't allowed to use the calendar on this iPhone. The owner can allow it in Juno > Settings > iPhone calendar and reminders.")
        }
    }

    private func listCalendars() throws -> JSONValue {
        try requireCalendar(read: true)
        let defaultId = store.defaultCalendarForNewEvents?.calendarIdentifier
        return .array(store.calendars(for: .event).map { calendar in
            .object([
                "id": .string(calendar.calendarIdentifier), "name": .string(calendar.title), "account": .string(calendar.source.title),
                "canAddEvents": .bool(calendar.allowsContentModifications), "default": .bool(calendar.calendarIdentifier == defaultId),
            ])
        })
    }

    private func listEvents(_ args: [String: JSONValue]) throws -> JSONValue {
        try requireCalendar(read: true)
        let from = try Self.date(args, "from"), to = try Self.date(args, "to")
        guard to > from else { throw PhoneCallError("`to` must be after `from`.") }
        let calendars = try args.string("calendar").map { [try eventCalendar($0)] }
        let limit = min(args.int("limit") ?? 30, 100)
        let events = store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: calendars)).sorted { $0.startDate < $1.startDate }
        return .array(events.prefix(limit).map(Self.json))
    }

    private func createEvent(_ args: [String: JSONValue]) throws -> JSONValue {
        try requireCalendar(read: false)
        let event = EKEvent(eventStore: store)
        event.title = try Self.requiredString(args, "title")
        event.startDate = try Self.date(args, "start")
        event.endDate = try Self.date(args, "end")
        guard event.endDate >= event.startDate else { throw PhoneCallError("`end` must not be before `start`.") }
        event.isAllDay = args.bool("allDay") ?? false
        event.location = args.string("location")
        event.notes = args.string("notes")
        // Write-only access cannot list calendars, so a named calendar needs full access; the default one always works.
        if let name = args.string("calendar") { event.calendar = try eventCalendar(name) }
        else if let fallback = store.defaultCalendarForNewEvents { event.calendar = fallback }
        else { throw PhoneCallError("There is no default calendar for new events on this iPhone.") }
        guard event.calendar.allowsContentModifications else { throw PhoneCallError("The calendar \"\(event.calendar.title)\" is read-only; pick another with `calendar`.") }
        try store.save(event, span: .thisEvent, commit: true)
        return Self.json(event)
    }

    private func updateEvent(_ args: [String: JSONValue]) throws -> JSONValue {
        try requireCalendar(read: true)
        try requireCalendar(read: false)
        let event = try existingEvent(try Self.requiredString(args, "id"))
        if let title = args.string("title") { event.title = title }
        if args["start"] != nil { event.startDate = try Self.date(args, "start") }
        if args["end"] != nil { event.endDate = try Self.date(args, "end") }
        if let location = args.string("location") { event.location = location }
        if let notes = args.string("notes") { event.notes = notes }
        guard event.endDate >= event.startDate else { throw PhoneCallError("`end` must not be before `start`.") }
        try store.save(event, span: Self.span(args), commit: true)
        return Self.json(event)
    }

    private func deleteEvent(_ args: [String: JSONValue]) throws -> JSONValue {
        try requireCalendar(read: true)
        try requireCalendar(read: false)
        let event = try existingEvent(try Self.requiredString(args, "id"))
        let summary = Self.json(event)
        try store.remove(event, span: Self.span(args), commit: true)
        return .object(["deleted": summary])
    }

    private func eventCalendar(_ nameOrId: String) throws -> EKCalendar {
        let all = store.calendars(for: .event)
        if let found = all.first(where: { $0.calendarIdentifier == nameOrId }) ?? all.first(where: { $0.title.caseInsensitiveCompare(nameOrId) == .orderedSame }) { return found }
        throw PhoneCallError("No calendar named \"\(nameOrId)\". Use phone_calendar_list_calendars to see them.")
    }

    /// An event id from `list_events`: the plain identifier, or `identifier@epoch` for one occurrence of a repeating event.
    private func existingEvent(_ id: String) throws -> EKEvent {
        let parts = id.split(separator: "@", maxSplits: 1).map(String.init)
        if parts.count == 2, let epoch = TimeInterval(parts[1]) {
            let start = Date(timeIntervalSince1970: epoch)
            let window = store.predicateForEvents(withStart: start.addingTimeInterval(-1), end: start.addingTimeInterval(1), calendars: nil)
            if let found = store.events(matching: window).first(where: { $0.eventIdentifier == parts[0] }) { return found }
        } else if let found = store.event(withIdentifier: id) { return found }
        throw PhoneCallError("No event with that id (it may have been changed or deleted). List the events again.")
    }

    /// `this` (default) or `future`: a repeating series is only changed as a whole when the agent says so.
    private static func span(_ args: [String: JSONValue]) -> EKSpan { args.string("span") == "future" ? .futureEvents : .thisEvent }

    private static func json(_ event: EKEvent) -> JSONValue {
        let repeating = event.hasRecurrenceRules
        var out: [String: JSONValue] = [
            "id": .string(repeating ? "\(event.eventIdentifier ?? "")@\(Int(event.startDate.timeIntervalSince1970))" : event.eventIdentifier ?? ""),
            "title": .string(event.title ?? ""), "start": .string(iso(event.startDate)), "end": .string(iso(event.endDate)),
            "allDay": .bool(event.isAllDay), "calendar": .string(event.calendar?.title ?? ""), "repeats": .bool(repeating),
        ]
        if let location = event.location, !location.isEmpty { out["location"] = .string(location) }
        if let notes = event.notes, !notes.isEmpty { out["notes"] = .string(String(notes.prefix(500))) }
        return .object(out)
    }

    // MARK: Reminders

    private func requireReminders() throws {
        guard Self.remindersAccess() == .full else {
            throw PhoneCallError("Juno isn't allowed to use Reminders on this iPhone. The owner can allow it in Juno > Settings > iPhone calendar and reminders.")
        }
    }

    private func listReminders(_ args: [String: JSONValue]) async throws -> JSONValue {
        try requireReminders()
        let lists = try args.string("list").map { [try reminderList($0)] }
        let limit = min(args.int("limit") ?? 30, 100)
        let predicate = (args.bool("includeCompleted") ?? false)
            ? store.predicateForReminders(in: lists)
            : store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: lists)
        let rows: [(due: Date?, json: JSONValue)] = await withCheckedContinuation { continuation in
            store.fetchReminders(matching: predicate) { reminders in
                continuation.resume(returning: (reminders ?? []).map { (Self.dueDate($0), Self.json($0)) })
            }
        }
        // Soonest due first, undated ones last.
        let sorted = rows.sorted { ($0.due ?? .distantFuture) < ($1.due ?? .distantFuture) }
        return .array(sorted.prefix(limit).map(\.json))
    }

    private func createReminder(_ args: [String: JSONValue]) throws -> JSONValue {
        try requireReminders()
        let reminder = EKReminder(eventStore: store)
        reminder.title = try Self.requiredString(args, "title")
        reminder.notes = args.string("notes")
        if let name = args.string("list") { reminder.calendar = try reminderList(name) }
        else if let fallback = store.defaultCalendarForNewReminders() { reminder.calendar = fallback }
        else { throw PhoneCallError("There is no default Reminders list on this iPhone.") }
        if args["due"] != nil { Self.setDue(reminder, try Self.date(args, "due")) }
        try store.save(reminder, commit: true)
        return Self.json(reminder)
    }

    private func updateReminder(_ args: [String: JSONValue]) throws -> JSONValue {
        try requireReminders()
        let reminder = try existingReminder(try Self.requiredString(args, "id"))
        if let title = args.string("title") { reminder.title = title }
        if let notes = args.string("notes") { reminder.notes = notes }
        if args["due"] != nil { Self.setDue(reminder, try Self.date(args, "due")) }
        if let completed = args.bool("completed") { reminder.isCompleted = completed }
        try store.save(reminder, commit: true)
        return Self.json(reminder)
    }

    private func deleteReminder(_ args: [String: JSONValue]) throws -> JSONValue {
        try requireReminders()
        let reminder = try existingReminder(try Self.requiredString(args, "id"))
        let summary = Self.json(reminder)
        try store.remove(reminder, commit: true)
        return .object(["deleted": summary])
    }

    private func reminderList(_ nameOrId: String) throws -> EKCalendar {
        let all = store.calendars(for: .reminder)
        if let found = all.first(where: { $0.calendarIdentifier == nameOrId }) ?? all.first(where: { $0.title.caseInsensitiveCompare(nameOrId) == .orderedSame }) { return found }
        throw PhoneCallError("No Reminders list named \"\(nameOrId)\".")
    }

    private func existingReminder(_ id: String) throws -> EKReminder {
        if let found = store.calendarItem(withIdentifier: id) as? EKReminder { return found }
        throw PhoneCallError("No reminder with that id (it may have been deleted). List the reminders again.")
    }

    /// A due date with a time; the alarm makes the phone actually remind at that moment.
    private static func setDue(_ reminder: EKReminder, _ date: Date) {
        reminder.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        reminder.alarms?.forEach { reminder.removeAlarm($0) }
        reminder.addAlarm(EKAlarm(absoluteDate: date))
    }

    private static func dueDate(_ reminder: EKReminder) -> Date? { reminder.dueDateComponents.flatMap { Calendar.current.date(from: $0) } }

    private static func json(_ reminder: EKReminder) -> JSONValue {
        var out: [String: JSONValue] = [
            "id": .string(reminder.calendarItemIdentifier), "title": .string(reminder.title ?? ""),
            "list": .string(reminder.calendar?.title ?? ""), "completed": .bool(reminder.isCompleted),
        ]
        if let due = dueDate(reminder) { out["due"] = .string(iso(due)) }
        if let notes = reminder.notes, !notes.isEmpty { out["notes"] = .string(String(notes.prefix(500))) }
        return .object(out)
    }

    // MARK: Dates and arguments

    /// ISO 8601 with this iPhone's offset.
    private static func iso(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = .current
        return formatter.string(from: date)
    }

    /// ISO 8601 with an offset (or Z), else a local time ("2026-10-22T15:00", "2026-10-22 15:00", "2026-10-22") in this iPhone's zone.
    static func parseDate(_ text: String) -> Date? {
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

    private static func date(_ args: [String: JSONValue], _ key: String) throws -> Date {
        let text = try requiredString(args, key)
        guard let date = parseDate(text) else { throw PhoneCallError("`\(key)` (\"\(text)\") is not a time I can read. Use ISO 8601 such as 2026-10-22T15:00:00+08:00.") }
        return date
    }

    private static func requiredString(_ args: [String: JSONValue], _ key: String) throws -> String {
        guard let value = args.string(key), !value.isEmpty else { throw PhoneCallError("`\(key)` is required.") }
        return value
    }
}

private extension Dictionary where Key == String, Value == JSONValue {
    func string(_ key: String) -> String? { if case .string(let value)? = self[key] { return value } else { return nil } }
    func bool(_ key: String) -> Bool? { if case .bool(let value)? = self[key] { return value } else { return nil } }
    func int(_ key: String) -> Int? { if case .number(let value)? = self[key] { return Int(value) } else { return nil } }
}
