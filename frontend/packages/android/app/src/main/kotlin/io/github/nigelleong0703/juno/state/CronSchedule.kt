package io.github.nigelleong0703.juno.state

import java.time.DayOfWeek
import java.time.Instant
import java.time.ZoneId

/**
 * A standard 5-field cron expression (minute hour day-of-month month day-of-week) with numbers, `*`, ranges, lists and
 * steps (iOS `CronSchedule`). Expands into fire times for the agents' calendar, in the timezone the routine is written in.
 * Null from [parse] means "not timed" (malformed or out of range).
 */
class CronSchedule private constructor(
    private val minutes: Set<Int>, private val hours: Set<Int>, private val days: Set<Int>, private val months: Set<Int>,
    private val weekdays: Set<Int>, private val anyDay: Boolean, private val anyWeekday: Boolean,
) {
    // Standard cron: when both day fields are restricted, either one matching is enough.
    private fun matches(day: Int, weekday: Int) =
        if (anyDay || anyWeekday) day in days && weekday in weekdays else day in days || weekday in weekdays

    /** Fire times in [from, to), oldest first, at most [limit]. */
    fun occurrences(from: Instant, to: Instant, zone: ZoneId, limit: Int = 200): List<Instant> {
        val result = mutableListOf<Instant>()
        var day = from.atZone(zone).toLocalDate()
        while (day.atStartOfDay(zone).toInstant() < to && result.size < limit) {
            // java.time Monday=1..Sunday=7; cron Sunday=0.
            val weekday = if (day.dayOfWeek == DayOfWeek.SUNDAY) 0 else day.dayOfWeek.value
            if (day.monthValue in months && matches(day.dayOfMonth, weekday)) {
                for (h in hours.sorted()) for (m in minutes.sorted()) {
                    val fire = day.atTime(h, m).atZone(zone).toInstant()
                    if (fire < from || fire >= to) continue
                    result += fire
                    if (result.size >= limit) return result
                }
            }
            day = day.plusDays(1)
        }
        return result
    }

    companion object {
        fun parse(expression: String): CronSchedule? {
            val parts = expression.trim().split(Regex("\\s+"))
            if (parts.size != 5) return null
            val minutes = field(parts[0], 0..59) ?: return null
            val hours = field(parts[1], 0..23) ?: return null
            val days = field(parts[2], 1..31) ?: return null
            val months = field(parts[3], 1..12) ?: return null
            val weekdays = field(parts[4], 0..7) ?: return null
            return CronSchedule(minutes, hours, days, months, weekdays.map { it % 7 }.toSet(), parts[2].startsWith("*"), parts[4].startsWith("*"))
        }

        /** One field as the set of values it allows, or null when malformed or out of range. */
        fun field(text: String, range: IntRange): Set<Int>? {
            val values = mutableSetOf<Int>()
            for (item in text.split(",")) {
                val halves = item.split("/")
                if (halves.size > 2) return null
                var step = 1
                if (halves.size == 2) step = halves[1].toIntOrNull()?.takeIf { it > 0 } ?: return null
                val base = halves[0]
                var low = range.first
                var high = range.last
                if (base != "*") {
                    val ends = base.split("-").map { it.toIntOrNull() }
                    if (ends.size > 2) return null
                    low = ends[0] ?: return null
                    high = if (ends.size == 2) (ends[1] ?: -1) else if (halves.size == 2) range.last else low
                }
                if (low !in range || high !in range || low > high) return null
                values += (low..high step step)
            }
            return values.takeIf { it.isNotEmpty() }
        }
    }
}
