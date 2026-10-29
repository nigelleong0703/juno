package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.AgentCalendarItem
import io.github.nigelleong0703.juno.contract.Routine
import io.github.nigelleong0703.juno.core.parseIso
import java.time.Instant
import java.time.ZoneId

/** What the routines calendar draws for one day (iOS RoutinesCalendar.swift:44-260). Pure so it is unit-tested. */
object RoutineCalendar {
    /** More fires than this in one day collapses into one "Hourly" chip and leaves the grid (spec 2.23). */
    const val DENSE_PER_DAY = 6
    const val BLOCK_MINUTES = 40

    /** One block on the timeline: a recorded run (past) or a cron fire time (future). */
    data class Occurrence(val routine: Routine, val start: Instant, val past: Boolean, val status: String?)
    /** One thing on the timeline: a routine occurrence or an item from an agent's own calendar. */
    data class Block(val start: Instant, val occurrence: Occurrence?, val item: AgentCalendarItem?) {
        val key get() = occurrence?.let { "${it.routine.id}-${it.start}" } ?: "item-${item?.id}"
    }
    data class Placed(val block: Block, val lane: Int, val lanes: Int)

    /** Only `schedule` triggers with a parsable cron are timed; the rest are "On demand". */
    fun isTimed(r: Routine) = r.trigger?.kind == "schedule" && CronSchedule.parse(r.trigger?.cron.orEmpty()) != null

    private fun fires(r: Routine, from: Instant, to: Instant): List<Instant> {
        val trigger = r.trigger ?: return emptyList()
        val cron = CronSchedule.parse(trigger.cron.orEmpty()) ?: return emptyList()
        val zone = trigger.tz?.let { runCatching { ZoneId.of(it) }.getOrNull() } ?: ZoneId.systemDefault()
        return cron.occurrences(from, to, zone)
    }

    fun dense(routines: List<Routine>, from: Instant, to: Instant) = routines.filter { isTimed(it) && fires(it, from, to).size > DENSE_PER_DAY }

    /** Past = the routine's recorded runs starting that day and before now; future = cron fires after now (spec 2.23). */
    fun occurrences(routines: List<Routine>, from: Instant, to: Instant, now: Instant = Instant.now()): List<Occurrence> {
        val result = mutableListOf<Occurrence>()
        for (r in routines.filter(::isTimed)) {
            val times = fires(r, from, to)
            if (times.size > DENSE_PER_DAY) continue
            for (run in r.runs.orEmpty()) {
                val start = parseIso(run.startedAt) ?: continue
                if (start >= from && start < to && start <= now) result += Occurrence(r, start, true, run.status)
            }
            for (t in times) if (t > now) result += Occurrence(r, t, false, null)
        }
        return result.sortedBy { it.start }
    }

    /** The agents' own calendar items on the visible day; cancelled ones are hidden; the agent filter applies. */
    fun dayItems(calendar: List<AgentCalendarItem>, from: Instant, to: Instant, scope: String?): List<AgentCalendarItem> =
        calendar.filter { item ->
            val at = parseIso(item.at) ?: return@filter false
            at >= from && at < to && item.status != "cancelled" && (scope == null || item.agentId == scope)
        }

    fun blocks(occurrences: List<Occurrence>, items: List<AgentCalendarItem>): List<Block> =
        (occurrences.map { Block(it.start, it, null) } + items.mapNotNull { i -> parseIso(i.at)?.let { Block(it, null, i) } }).sortedBy { it.start }

    /** Overlapping blocks share the width in lanes: a cluster ends when the next block starts after every lane is free. */
    fun lanes(blocks: List<Block>, zone: ZoneId = ZoneId.systemDefault()): List<Placed> {
        val result = mutableListOf<Placed>()
        var cluster = mutableListOf<Pair<Block, Int>>()
        var laneEnds = mutableListOf<Int>()
        var clusterEnd = -1
        fun flush() { cluster.forEach { (b, lane) -> result += Placed(b, lane, laneEnds.size) }; cluster = mutableListOf(); laneEnds = mutableListOf() }
        for (b in blocks) {
            val start = minutesOfDay(b.start, zone)
            if (start >= clusterEnd) flush()
            var lane = laneEnds.indexOfFirst { it <= start }
            if (lane < 0) { lane = laneEnds.size; laneEnds += 0 }
            laneEnds[lane] = start + BLOCK_MINUTES
            clusterEnd = maxOf(clusterEnd, start + BLOCK_MINUTES)
            cluster += b to lane
        }
        flush()
        return result
    }

    fun minutesOfDay(at: Instant, zone: ZoneId = ZoneId.systemDefault()): Int = at.atZone(zone).let { it.hour * 60 + it.minute }
}
