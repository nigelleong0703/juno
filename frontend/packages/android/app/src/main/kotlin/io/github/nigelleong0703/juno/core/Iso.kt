package io.github.nigelleong0703.juno.core

import java.time.Instant
import java.time.OffsetDateTime

/** Wire dates are ISO-8601 strings, with or without fractional seconds, `Z` or an offset. Null when absent or malformed. */
fun parseIso(text: String?): Instant? {
    if (text.isNullOrEmpty()) return null
    return runCatching { Instant.parse(text) }.getOrNull()
        ?: runCatching { OffsetDateTime.parse(text).toInstant() }.getOrNull()
}

/** The current time as the wire writes it. */
fun nowIso(): String = Instant.now().toString()
