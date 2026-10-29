import Foundation

/// A standard 5-field cron expression (minute hour day-of-month month day-of-week) with numbers, `*`, ranges,
/// lists and steps (`*/15`, `1-5`, `8-18/2`, `1,3,5`). Expands into fire times for the agents' calendar, in the
/// timezone the routine is written in. Mirrors web `occurrences.ts` (croner) for the presets the apps offer.
struct CronSchedule: Equatable {
    let minutes: Set<Int>, hours: Set<Int>, days: Set<Int>, months: Set<Int>, weekdays: Set<Int>
    private let anyDay: Bool, anyWeekday: Bool

    init?(_ expression: String) {
        let parts = expression.split(whereSeparator: \.isWhitespace).map(String.init)
        guard parts.count == 5,
              let minutes = Self.field(parts[0], 0...59), let hours = Self.field(parts[1], 0...23),
              let days = Self.field(parts[2], 1...31), let months = Self.field(parts[3], 1...12),
              let weekdays = Self.field(parts[4], 0...7) else { return nil }
        self.minutes = minutes; self.hours = hours; self.days = days; self.months = months
        self.weekdays = Set(weekdays.map { $0 % 7 })
        anyDay = parts[2].hasPrefix("*"); anyWeekday = parts[4].hasPrefix("*")
    }

    /// One field as the set of values it allows, or nil when it is malformed or out of range.
    static func field(_ text: String, _ range: ClosedRange<Int>) -> Set<Int>? {
        var values = Set<Int>()
        for item in text.split(separator: ",", omittingEmptySubsequences: false) {
            let halves = item.split(separator: "/", omittingEmptySubsequences: false)
            guard halves.count <= 2 else { return nil }
            var step = 1
            if halves.count == 2 {
                guard let value = Int(halves[1]), value > 0 else { return nil }
                step = value
            }
            let base = String(halves[0])
            var low = range.lowerBound, high = range.upperBound
            if base != "*" {
                let ends = base.split(separator: "-", omittingEmptySubsequences: false).map { Int($0) }
                guard ends.count <= 2, let first = ends[0] else { return nil }
                low = first
                high = ends.count == 2 ? (ends[1] ?? -1) : (halves.count == 2 ? range.upperBound : first)
            }
            guard range.contains(low), range.contains(high), low <= high else { return nil }
            values.formUnion(stride(from: low, through: high, by: step))
        }
        return values.isEmpty ? nil : values
    }

    private func matches(day: Int, weekday: Int) -> Bool {
        // Standard cron: when both day fields are restricted, either one matching is enough.
        if anyDay || anyWeekday { return days.contains(day) && weekdays.contains(weekday) }
        return days.contains(day) || weekdays.contains(weekday)
    }

    /// Fire times in `[from, to)`, oldest first, at most `limit`.
    func occurrences(from: Date, to: Date, in timeZone: TimeZone, limit: Int = 200) -> [Date] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        var result: [Date] = []
        var day = calendar.startOfDay(for: from)
        while day < to, result.count < limit {
            let parts = calendar.dateComponents([.month, .day, .weekday], from: day)
            if months.contains(parts.month ?? 0), matches(day: parts.day ?? 0, weekday: (parts.weekday ?? 1) - 1) {
                for hour in hours.sorted() {
                    for minute in minutes.sorted() {
                        guard let fire = calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day),
                              fire >= from, fire < to else { continue }
                        result.append(fire)
                        if result.count >= limit { return result }
                    }
                }
            }
            guard let next = calendar.date(byAdding: .day, value: 1, to: day) else { break }
            day = next
        }
        return result
    }
}
