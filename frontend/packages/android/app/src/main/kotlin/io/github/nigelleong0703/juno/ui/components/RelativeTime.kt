package io.github.nigelleong0703.juno.ui.components

import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** Short relative times as the apps show them: "now", "5m", "2h", "3d", "2w", then a date (iOS `Fmt.ago`). */
object RelativeTime {
    private val date = DateTimeFormatter.ofPattern("d MMM", Locale.ENGLISH)

    fun short(at: Instant?, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
        if (at == null) return ""
        val seconds = Duration.between(at, now).seconds
        return when {
            seconds < 60 -> "now"
            seconds < HOUR -> "${seconds / 60}m"
            seconds < DAY -> "${seconds / HOUR}h"
            seconds < WEEK -> "${seconds / DAY}d"
            seconds < MONTH -> "${seconds / WEEK}w"
            else -> at.atZone(zone).format(date)
        }
    }

    private const val HOUR = 3_600L
    private const val DAY = 86_400L
    private const val WEEK = 7 * DAY
    private const val MONTH = 30 * DAY
}
