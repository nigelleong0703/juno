package io.github.nigelleong0703.juno.core

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

/** A signed-in account: where it lives and the Better Auth token sent as `Authorization: Bearer`. */
@Serializable
data class Session(
    val server: String,
    val token: String,
    val userId: String,
    val name: String,
    val email: String,
)

/**
 * Persists the one [Session]. App-private SharedPreferences (sandboxed and file-encrypted by Android); the iOS
 * Keychain has no direct equivalent without the deprecated security-crypto library. Swap here if that changes.
 */
class SessionStore(context: Context) {
    private val prefs = context.getSharedPreferences("juno.session", Context.MODE_PRIVATE)

    fun load(): Session? =
        prefs.getString(KEY, null)?.let { runCatching { JunoJson.decodeFromString<Session>(it) }.getOrNull() }

    fun save(session: Session?) {
        prefs.edit().apply {
            if (session == null) remove(KEY) else putString(KEY, JunoJson.encodeToString(session))
        }.apply()
    }

    private companion object { const val KEY = "session" }
}
