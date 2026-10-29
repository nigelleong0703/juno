import Foundation

extension World {
    /// GET /v1/calendar?from&to: the agents' own calendar items (follow-ups, meetings, tasks) that fall in `[from, to)`.
    func loadCalendar(from: Date, to: Date) async {
        guard let api else { calendarItems = []; return }
        let stamp = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        var components = URLComponents()
        components.path = "/v1/calendar"
        components.queryItems = [URLQueryItem(name: "from", value: from.formatted(stamp)), URLQueryItem(name: "to", value: to.formatted(stamp))]
        struct Reply: Decodable { var items: [Contract.AgentCalendarItem] }
        if let reply = try? await api.get(components.string ?? "/v1/calendar", as: Reply.self) { calendarItems = reply.items }
    }

    /// DELETE /v1/calendar/:id: the item stays on the server as cancelled and drops off the calendar.
    func cancelCalendarItem(_ id: String) {
        if let i = calendarItems.firstIndex(where: { $0.id == id }) { calendarItems[i].status = "cancelled" }
        remote { try await $0.delete("/v1/calendar/\(id)") }
    }
}
