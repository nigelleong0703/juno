package io.github.nigelleong0703.juno.core

import kotlinx.serialization.json.Json

/**
 * The one Json config. Lenient on purpose: the backend adds fields faster than the app ships (ignoreUnknownKeys),
 * null and absent mean the same (explicitNulls = false), and a bad enum-ish value falls back to its default.
 */
val JunoJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
}
