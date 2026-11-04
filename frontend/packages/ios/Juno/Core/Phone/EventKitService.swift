import CoreLocation
import EventKit
import Foundation
import MapKit

/// Calendar and Reminders through EventKit, for the agent (backend BACKEND 7.13). The service only runs what `PhoneDevice`
/// hands it while the app is open; it never reads or writes by itself. Results are plain JSON for the model: ids, titles, times
/// as ISO 8601 with this iPhone's offset, short notes.
extension PhoneAccess {
    init(_ status: EKAuthorizationStatus) {
        switch status {
        case .fullAccess: self = .full
        case .writeOnly: self = .writeOnly
        case .notDetermined: self = .notAsked
        default: self = .denied
        }
    }
}

/// The two stores as the owner's switches see them: Calendar and Reminders are separate rows over one EventKit service.
@MainActor struct CalendarSystem: PhoneSystem {
    let service: EventKitService
    var access: PhoneAccess { EventKitService.calendarAccess() }
    func request() async { await service.requestCalendar() }
    /// Write-only calendar access can add events but not read any.
    func actions(for access: PhoneAccess) -> [String] {
        switch access {
        case .full: ["calendar.read", "calendar.write"]
        case .writeOnly: ["calendar.write"]
        default: []
        }
    }
    func run(_ action: String, _ args: [String: JSONValue]) async throws -> JSONValue { try await service.run(action, args) }
    func changes(_ action: String) -> Bool { action.hasSuffix("create_event") || action.hasSuffix("update_event") || action.hasSuffix("delete_event") }
}

@MainActor struct RemindersSystem: PhoneSystem {
    let service: EventKitService
    var access: PhoneAccess { EventKitService.remindersAccess() }
    func request() async { await service.requestReminders() }
    func actions(for access: PhoneAccess) -> [String] { access == .full ? ["reminders.read", "reminders.write"] : [] }
    func run(_ action: String, _ args: [String: JSONValue]) async throws -> JSONValue { try await service.run(action, args) }
    func changes(_ action: String) -> Bool { ["reminders.create", "reminders.update", "reminders.delete"].contains(action) }
}

actor EventKitService {
    private let store = EKEventStore()

    // MARK: Authorization

    nonisolated static func calendarAccess() -> PhoneAccess { PhoneAccess(EKEventStore.authorizationStatus(for: .event)) }
    nonisolated static func remindersAccess() -> PhoneAccess { PhoneAccess(EKEventStore.authorizationStatus(for: .reminder)) }

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
        case "reminders.create": return try await remindersBatch(args) { try await self.createReminder($0) }
        case "reminders.update": return try await remindersBatch(args) { try self.updateReminder($0) }
        case "reminders.delete": return try await remindersBatch(args) { try self.deleteReminder($0) }
        default: throw PhoneCallError("This version of Juno on the iPhone does not know \(action).")
        }
    }

    // MARK: Calendar

    private func requireCalendar(read: Bool) throws {
        switch Self.calendarAccess() {
        case .full: return
        case .writeOnly where !read: return
        case .writeOnly: throw PhoneCallError("Juno only has add-only access to the calendar, so it can't read it. The owner can allow full access in iPhone Settings > Juno > Calendars.")
        default: throw PhoneCallError("Juno isn't allowed to use the calendar on this iPhone. The owner can switch it on in Juno > Settings > iPhone access.")
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
            throw PhoneCallError("Juno isn't allowed to use Reminders on this iPhone. The owner can switch it on in Juno > Settings > iPhone access.")
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

    /// A reminder one item of a batch touched; `summary` is set when it must be read before the change (a delete).
    private struct Touched {
        let reminder: EKReminder
        var summary: JSONValue?
    }

    /// Runs a write on every reminder of `args.reminders` (1 to 20), saving each without committing and committing once at the end.
    /// The answer is per item, in the order sent: `{ok: true, reminder}` or `{ok: false, error}`. One item failing does not stop the others.
    private func remindersBatch(_ args: [String: JSONValue], _ apply: ([String: JSONValue]) async throws -> Touched) async throws -> JSONValue {
        try requireReminders()
        guard case .array(let items)? = args["reminders"], (1...20).contains(items.count) else {
            throw PhoneCallError("Give 1 to 20 reminders in \"reminders\". Nothing was changed.")
        }
        var outcomes: [Result<Touched, PhoneCallError>] = []
        for item in items {
            do { outcomes.append(.success(try await apply(item.fields ?? [:]))) }
            catch let error as PhoneCallError { outcomes.append(.failure(error)) }
            catch { outcomes.append(.failure(PhoneCallError(error.localizedDescription))) }
        }
        if outcomes.contains(where: { if case .success = $0 { true } else { false } }) {
            do { try store.commit() } catch {
                store.reset()
                throw PhoneCallError("Reminders refused the changes, so none were saved: \(error.localizedDescription)")
            }
        }
        // Read after the commit: a new reminder only has its final id once it is saved.
        return .object(["results": .array(outcomes.map { outcome in
            switch outcome {
            case .success(let touched): .object(["ok": .bool(true), "reminder": touched.summary ?? Self.json(touched.reminder)])
            case .failure(let error): .object(["ok": .bool(false), "error": .string(error.message)])
            }
        })])
    }

    private func createReminder(_ args: [String: JSONValue]) async throws -> Touched {
        let reminder = EKReminder(eventStore: store)
        reminder.title = try Self.requiredString(args, "title")
        reminder.notes = args.string("notes")
        if let name = args.string("list") { reminder.calendar = try reminderList(name) }
        else if let fallback = store.defaultCalendarForNewReminders() { reminder.calendar = fallback }
        else { throw PhoneCallError("There is no default Reminders list on this iPhone.") }
        if args["due"] != nil { Self.setDue(reminder, try Self.date(args, "due")) }
        if let place = args["place"]?.fields { reminder.addAlarm(try await Self.locationAlarm(place)) }
        try store.save(reminder, commit: false)
        return Touched(reminder: reminder)
    }

    /// A location alarm, the system's own geofence in Reminders (no tracking by Juno): fires when arriving at or leaving the place.
    /// Without coordinates the place is looked up on the map; a name that finds nothing is an error the agent can act on.
    private static func locationAlarm(_ place: [String: JSONValue]) async throws -> EKAlarm {
        let name = try place.requiredString("name")
        var title = name
        let location: CLLocation
        if let latitude = place.double("latitude"), let longitude = place.double("longitude") {
            location = CLLocation(latitude: latitude, longitude: longitude)
        } else {
            let request = MKLocalSearch.Request()
            request.naturalLanguageQuery = name
            guard let found = try? await MKLocalSearch(request: request).start().mapItems.first else {
                throw PhoneCallError("The map found no place called \"\(name)\". Ask the user for a street address, or pass latitude and longitude. Nothing was added.")
            }
            location = found.location
            title = found.name ?? name
        }
        let structured = EKStructuredLocation(title: title)
        structured.geoLocation = location
        structured.radius = place.double("radiusMeters") ?? 0
        let alarm = EKAlarm()
        alarm.structuredLocation = structured
        alarm.proximity = place.string("when") == "leaving" ? .leave : .enter
        return alarm
    }

    private func updateReminder(_ args: [String: JSONValue]) throws -> Touched {
        let reminder = try existingReminder(try Self.requiredString(args, "id"))
        // Read the new due time first so an unreadable one leaves the reminder untouched.
        let due = args["due"] == nil ? nil : try Self.date(args, "due")
        if let title = args.string("title") { reminder.title = title }
        if let notes = args.string("notes") { reminder.notes = notes }
        if let due { Self.setDue(reminder, due) }
        if let completed = args.bool("completed") { reminder.isCompleted = completed }
        do { try store.save(reminder, commit: false) } catch { reminder.reset(); throw error }
        return Touched(reminder: reminder)
    }

    private func deleteReminder(_ args: [String: JSONValue]) throws -> Touched {
        let reminder = try existingReminder(try Self.requiredString(args, "id"))
        let summary = Self.json(reminder)
        try store.remove(reminder, commit: false)
        return Touched(reminder: reminder, summary: summary)
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
        if let alarm = reminder.alarms?.first(where: { $0.structuredLocation != nil }), let place = alarm.structuredLocation {
            out["place"] = .object([
                "name": .string(place.title ?? ""), "when": .string(alarm.proximity == .leave ? "leaving" : "arriving"),
                "latitude": .number(place.geoLocation?.coordinate.latitude ?? 0), "longitude": .number(place.geoLocation?.coordinate.longitude ?? 0),
            ])
        }
        return .object(out)
    }

    // MARK: Dates and arguments

    private static func iso(_ date: Date) -> String { PhoneTime.iso(date) }
    private static func date(_ args: [String: JSONValue], _ key: String) throws -> Date { try PhoneTime.date(args, key) }
    private static func requiredString(_ args: [String: JSONValue], _ key: String) throws -> String { try args.requiredString(key) }
}
