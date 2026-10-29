package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.Profile
import io.github.nigelleong0703.juno.contract.ProfileEntry
import io.github.nigelleong0703.juno.contract.ProfileSource
import io.github.nigelleong0703.juno.contract.PutProfileEntry
import io.github.nigelleong0703.juno.contract.PutProfileInput
import io.github.nigelleong0703.juno.core.ApiException
import io.github.nigelleong0703.juno.core.JunoJson
import io.github.nigelleong0703.juno.core.parseIso
import kotlinx.coroutines.CancellationException
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** The editor's limits. The server may refuse more; its message is shown in the sheet. */
const val PROFILE_KEY_MAX = 60
const val PROFILE_VALUE_MAX = 2000

/** The values in the "Add detail" / "Edit detail" sheet. Trimmed when saved (iOS `ProfileDraft`). */
data class ProfileDraft(val key: String = "", val value: String = "", val shared: Boolean = false) {
    val trimmedKey: String get() = key.trim()
    val trimmedValue: String get() = value.trim()
    val canSave: Boolean
        get() = trimmedKey.isNotEmpty() && trimmedValue.isNotEmpty() &&
            trimmedKey.length <= PROFILE_KEY_MAX && trimmedValue.length <= PROFILE_VALUE_MAX
}

fun ProfileEntry.toDraft(): ProfileDraft = ProfileDraft(key = key.orEmpty(), value = value.orEmpty(), shared = isShared)

val ProfileEntry.isShared: Boolean get() = visibility == ProfileEntry.VisibilityValue.shared

/** GET /v1/profile: the account's details, one flat list (empty when nothing is saved). */
suspend fun World.loadProfile(): List<ProfileEntry> {
    val api = api ?: throw ApiException.NotSignedIn
    return api.get<Profile>("/v1/profile").entries.orEmpty()
}

/**
 * PUT /v1/profile replaces the whole list, so every save sends everything; the server's copy (with sources) comes back.
 * A session change while the call was in flight voids the result.
 */
suspend fun World.saveProfile(entries: List<ProfileEntry>): List<ProfileEntry> {
    val api = api ?: throw ApiException.NotSignedIn
    val saved = JunoJson.decodeFromString<Profile>(api.put("/v1/profile", profilePutInput(entries))).entries.orEmpty()
    if (!isCurrent(api)) throw CancellationException("session changed")
    return saved
}

/** The wire body for a whole list. An entry without a visibility is private, as iOS saves it. */
fun profilePutInput(entries: List<ProfileEntry>): PutProfileInput = PutProfileInput(
    entries = entries.map { PutProfileEntry(id = it.id, key = it.key, value = it.value, visibility = it.visibility ?: ProfileEntry.VisibilityValue.private) },
)

/**
 * The list with a draft saved: an edit replaces its entry in place (keeping its source), a new detail is appended.
 * An edit whose entry has gone (removed elsewhere since the sheet opened) is refused rather than silently dropped.
 */
fun applyProfileDraft(entries: List<ProfileEntry>, editingId: String?, draft: ProfileDraft, newId: String): List<ProfileEntry> {
    val visibility = if (draft.shared) ProfileEntry.VisibilityValue.shared else ProfileEntry.VisibilityValue.private
    if (editingId == null) {
        return entries + ProfileEntry(id = newId, key = draft.trimmedKey, value = draft.trimmedValue, visibility = visibility)
    }
    if (entries.none { it.id == editingId }) {
        throw ApiException.Http(404, "This detail was removed elsewhere. Close this and open it again.")
    }
    return entries.map { if (it.id == editingId) it.copy(key = draft.trimmedKey, value = draft.trimmedValue, visibility = visibility) else it }
}

/** Who can use one detail, changed on the whole list. */
fun setProfileVisibility(entries: List<ProfileEntry>, id: String, shared: Boolean): List<ProfileEntry> {
    val visibility = if (shared) ProfileEntry.VisibilityValue.shared else ProfileEntry.VisibilityValue.private
    return entries.map { if (it.id == id) it.copy(visibility = visibility) else it }
}

/** The source line under a detail: "Added by you", or "Learned by <agent> · <date>" (the date when the server gave one). */
fun profileSourceLine(entry: ProfileEntry, agentName: String?): String {
    val source: ProfileSource = entry.source ?: return "Added by you"
    if (source.by != ProfileSource.ByValue.agent) return "Added by you"
    val name = agentName ?: "your agent"
    val at = parseIso(source.at) ?: return "Learned by $name"
    val day = DateTimeFormatter.ofPattern("MMM d", Locale.getDefault()).format(at.atZone(ZoneId.systemDefault()))
    return "Learned by $name · $day"
}
