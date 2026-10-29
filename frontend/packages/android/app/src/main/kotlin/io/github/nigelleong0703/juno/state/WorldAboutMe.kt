package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.AgentHomeFile
import io.github.nigelleong0703.juno.contract.WriteHomeFileInput
import io.github.nigelleong0703.juno.core.ApiException
import kotlinx.serialization.Serializable
import java.net.URLEncoder

@Serializable private class HomeFilesReply(val files: List<AgentHomeFile> = emptyList())

/** GET /v1/home?path=<prefix>: the user's files whose path starts with the prefix. Without a server there are none. */
suspend fun World.homeFiles(prefix: String): List<AgentHomeFile> {
    val api = api ?: return emptyList()
    return api.get<HomeFilesReply>("/v1/home?path=${URLEncoder.encode(prefix, "UTF-8")}").files
}

/**
 * The file at exactly [path] (the list endpoint matches a prefix, so the exact one is picked here), or null when it
 * does not exist yet.
 */
suspend fun World.homeFile(path: String): AgentHomeFile? = homeFiles(path).firstOrNull { it.path == path }

/**
 * PUT /v1/home/<path> with the hash the file was loaded with. The server refuses a stale hash with 409 HOME_CONFLICT
 * ([isHomeConflict]): the caller reloads and asks the user to make the edit again, never overwrites.
 */
suspend fun World.writeHomeFile(path: String, content: String, expectedHash: String?) {
    val api = api ?: throw ApiException.NotSignedIn
    api.put("/v1/home/${encodeHomePath(path)}", WriteHomeFileInput(content = content, expectedHash = expectedHash))
}

/** The file changed elsewhere since it was loaded. */
val Throwable.isHomeConflict: Boolean
    get() = this is ApiException.Api && code == "HOME_CONFLICT"

/** Each path segment percent-encoded (spaces as %20, not "+"); the slashes stay. */
internal fun encodeHomePath(path: String): String =
    path.split("/").joinToString("/") { URLEncoder.encode(it, "UTF-8").replace("+", "%20") }
