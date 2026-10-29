package io.github.nigelleong0703.juno.ui.chat

import io.github.nigelleong0703.juno.contract.Request
import io.github.nigelleong0703.juno.core.parseIso
import io.github.nigelleong0703.juno.state.Fmt
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.format.TextStyle
import java.util.Locale

/** Pure text helpers shared by the chat screens: the iOS `Fmt` words, greeting bands and day labels. */
object ChatFormat {
    /** "45s", "1m 20s", "1h 5m": the live status row's ticking clock. */
    fun elapsed(seconds: Long): String {
        val s = maxOf(0, seconds)
        return when {
            s < 60 -> "${s}s"
            s < 3600 -> "${s / 60}m ${s % 60}s"
            else -> "${s / 3600}h ${s % 3600 / 60}m"
        }
    }

    fun bytes(n: Long?): String {
        n ?: return ""
        // iOS `ByteCountFormatter(.file)`: "69 bytes", then decimal KB / MB / GB (one decimal under 10).
        if (n < 1000) return "$n bytes"
        var value = n / 1000.0
        var unit = 0
        while (value >= 1000 && unit < 2) { value /= 1000; unit++ }
        val label = listOf("KB", "MB", "GB")[unit]
        return if (value < 10) String.format(Locale.US, "%.1f %s", value, label) else String.format(Locale.US, "%.0f %s", value, label)
    }

    fun ago(iso: String?, now: Instant = Instant.now()): String {
        val t = parseIso(iso) ?: return ""
        val s = maxOf(0, now.epochSecond - t.epochSecond)
        return when {
            s < 60 -> "just now"
            s < 3600 -> "${s / 60} min ago"
            s < 86400 -> "${s / 3600} hr ago"
            else -> "${s / 86400} d ago"
        }
    }

    /** Same bands as the web Today page: late night 0-5 asks "Still up, robin?" instead of greeting. */
    fun greeting(hour: Int, name: String): String {
        if (hour < 5) return if (name.isEmpty()) "Still up?" else "Still up, $name?"
        val base = when (hour) { in 5..11 -> "Good morning"; in 12..17 -> "Good afternoon"; else -> "Good evening" }
        return if (name.isEmpty()) base else "$base, $name"
    }

    /** "Today", "Yesterday", the weekday within 7 days, else "d MMM" (+ year when it is another year). */
    fun dayLabel(day: LocalDate, today: LocalDate = LocalDate.now()): String {
        val ago = today.toEpochDay() - day.toEpochDay()
        return when {
            ago == 0L -> "Today"
            ago == 1L -> "Yesterday"
            ago in 2..6 -> day.dayOfWeek.getDisplayName(TextStyle.FULL, Locale.getDefault())
            day.year == today.year -> day.format(DateTimeFormatter.ofPattern("d MMM", Locale.getDefault()))
            else -> day.format(DateTimeFormatter.ofPattern("d MMM yyyy", Locale.getDefault()))
        }
    }

    /** The chat list's time column: the clock today, else the date. */
    fun listTime(iso: String?, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
        val t = parseIso(iso)?.atZone(zone) ?: return ""
        val today = now.atZone(zone).toLocalDate()
        return if (t.toLocalDate() == today) Fmt.time(iso, zone) else dayLabel(t.toLocalDate(), today)
    }

    /** One sentence for what a request wants: the brief's, else its own title. */
    fun sentence(r: Request): String =
        r.payload?.brief?.sentence?.takeIf { it.isNotEmpty() } ?: r.title?.takeIf { it.isNotEmpty() } ?: Fmt.requestTitle(r.kind)

    fun initials(name: String): String = name.split(' ').filter { it.isNotEmpty() }.take(2).joinToString("") { it.take(1) }.uppercase()
}

/** The iOS `Quote`: a leading block of "> " lines is a quoted reply (the backend has no reply field). */
object Quote {
    data class Split(val quote: String?, val body: String)

    fun split(text: String): Split {
        val lines = text.split("\n")
        val quoted = lines.takeWhile { it.startsWith(">") }.map { it.removePrefix(">").trimStart(' ') }
        if (quoted.isEmpty()) return Split(null, text)
        val body = lines.drop(quoted.size).dropWhile { it.isBlank() }.joinToString("\n")
        return Split(quoted.joinToString("\n"), body)
    }

    /** "> first ~140 characters\n\n" for the message being replied to. */
    fun prefix(text: String): String {
        val source = split(text).body
        val cut = if (source.length > 140) source.take(140) + "…" else source
        return cut.split("\n").joinToString("\n") { "> $it" } + "\n\n"
    }
}
