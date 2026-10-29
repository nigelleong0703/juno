import XCTest
@testable import Juno

// The agents' calendar expands routine crons on the phone: 5-field syntax in the routine's own timezone.

final class CronScheduleTests: XCTestCase {
    private func utc(_ iso: String) -> Date { ISO8601DateFormatter().date(from: iso)! }
    private func iso(_ dates: [Date]) -> [String] { dates.map { ISO8601DateFormatter().string(from: $0) } }

    func testFieldSyntax() {
        XCTAssertEqual(CronSchedule.field("*/15", 0...59), [0, 15, 30, 45])
        XCTAssertEqual(CronSchedule.field("1-5", 0...7), [1, 2, 3, 4, 5])
        XCTAssertEqual(CronSchedule.field("1,3,5", 0...7), [1, 3, 5])
        XCTAssertEqual(CronSchedule.field("8-18/5", 0...23), [8, 13, 18])
        XCTAssertNil(CronSchedule.field("61", 0...59))
        XCTAssertNil(CronSchedule.field("a", 0...59))
        XCTAssertNil(CronSchedule("0 9 * *"))
    }

    func testWeekdaysAtNine() throws {
        let cron = try XCTUnwrap(CronSchedule("0 9 * * 1-5"))
        // 2026-10-19 is a Monday; the range covers Mon..Sun.
        let fires = cron.occurrences(from: utc("2026-10-19T00:00:00Z"), to: utc("2026-10-26T00:00:00Z"), in: TimeZone(identifier: "UTC")!)
        XCTAssertEqual(fires.count, 5)
        XCTAssertEqual(iso(fires).first, "2026-10-19T09:00:00Z")
        XCTAssertEqual(iso(fires).last, "2026-10-23T09:00:00Z")
    }

    func testRoutineTimezoneIsConverted() throws {
        let cron = try XCTUnwrap(CronSchedule("0 9 * * *"))
        let fires = cron.occurrences(from: utc("2026-10-21T00:00:00Z"), to: utc("2026-10-22T00:00:00Z"), in: TimeZone(identifier: "Asia/Tokyo")!)
        XCTAssertEqual(iso(fires), ["2026-10-21T00:00:00Z"])
    }

    func testSundayAsSevenAndLimit() throws {
        let sunday = try XCTUnwrap(CronSchedule("30 8 * * 7"))
        let fires = sunday.occurrences(from: utc("2026-10-19T00:00:00Z"), to: utc("2026-10-27T00:00:00Z"), in: TimeZone(identifier: "UTC")!)
        XCTAssertEqual(iso(fires), ["2026-10-25T08:30:00Z"])
        let hourly = try XCTUnwrap(CronSchedule("0 * * * *"))
        XCTAssertEqual(hourly.occurrences(from: utc("2026-10-19T00:00:00Z"), to: utc("2026-12-19T00:00:00Z"), in: TimeZone(identifier: "UTC")!, limit: 50).count, 50)
    }
}
