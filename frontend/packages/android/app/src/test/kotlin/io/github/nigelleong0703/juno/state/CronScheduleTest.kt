package io.github.nigelleong0703.juno.state

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

class CronScheduleTest {
    private val utc = ZoneId.of("UTC")
    private fun fires(expr: String, from: String, to: String) =
        CronSchedule.parse(expr)!!.occurrences(Instant.parse(from), Instant.parse(to), utc).map { it.toString() }

    @Test fun `malformed or out of range expressions are not timed`() {
        assertNull(CronSchedule.parse("* * * *"))
        assertNull(CronSchedule.parse("60 * * * *"))
        assertNull(CronSchedule.parse("*/0 * * * *"))
        assertNull(CronSchedule.parse("5-2 * * * *"))
        assertNotNull(CronSchedule.parse("0 9 * * 1-5"))
    }

    @Test fun `steps ranges and lists expand`() {
        assertEquals(setOf(0, 15, 30, 45), CronSchedule.field("*/15", 0..59))
        assertEquals(setOf(8, 10, 12), CronSchedule.field("8-12/2", 0..23))
        assertEquals(setOf(1, 3, 5), CronSchedule.field("1,3,5", 0..7))
    }

    @Test fun `weekday 7 is sunday and the window is half open`() {
        // 2026-10-25 is a Sunday.
        assertEquals(listOf("2026-10-25T09:00:00Z"), fires("0 9 * * 7", "2026-10-24T00:00:00Z", "2026-10-26T00:00:00Z"))
        assertEquals(emptyList<String>(), fires("0 9 * * 0", "2026-10-25T09:00:01Z", "2026-10-26T09:00:00Z"))
    }

    @Test fun `day of month and weekday both restricted match either`() {
        // 2026-10-05 is a Monday; the 1st is a Thursday: "1st or Monday".
        val result = fires("0 0 1 * 1", "2026-10-01T00:00:00Z", "2026-10-09T00:00:00Z")
        assertEquals(listOf("2026-10-01T00:00:00Z", "2026-10-05T00:00:00Z"), result)
    }

    @Test fun `only one restricted day field must match both`() {
        // Every day-of-month 1..31, Mondays only.
        assertEquals(listOf("2026-10-05T00:00:00Z"), fires("0 0 * * 1", "2026-10-01T00:00:00Z", "2026-10-09T00:00:00Z"))
    }

    @Test fun `the result is capped`() {
        assertEquals(200, CronSchedule.parse("* * * * *")!!.occurrences(Instant.parse("2026-10-01T00:00:00Z"), Instant.parse("2026-10-30T00:00:00Z"), utc).size)
    }

    @Test fun `times are in the routine's zone`() {
        val tokyo = ZoneId.of("Asia/Tokyo")
        val out = CronSchedule.parse("0 9 * * *")!!.occurrences(Instant.parse("2026-10-01T00:00:00Z"), Instant.parse("2026-10-02T00:00:00Z"), tokyo)
        assertEquals(listOf("2026-10-01T00:00:00Z"), out.map { it.toString() })
    }
}
