package io.github.nigelleong0703.juno.state

import android.util.Base64
import io.github.nigelleong0703.juno.contract.Attachment
import io.github.nigelleong0703.juno.contract.Step
import io.github.nigelleong0703.juno.core.ApiException
import io.github.nigelleong0703.juno.core.JunoJson
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

@Serializable private class UploadBody(val name: String, val mimeType: String, val contentBase64: String)
@Serializable private class UploadEnvelope(val attachment: Attachment? = null)
@Serializable private class DownloadReply(val name: String = "", val mimeType: String = "", val contentBase64: String = "")
@Serializable private class RenderReply(val url: String, val expiresAt: String? = null)

/** The conversation screen is showing [id]: it becomes the open chat (incoming items are read as they arrive) and its first page loads. */
fun World.enterChat(id: String) {
    update { it.copy(currentConversationId = id) }
    prepareChat(id)
}

/** Keeps (or clears, with an empty text) a chat's unsent composer text so leaving and returning restores it. */
fun World.setDraft(id: String, text: String) = update { s -> s.copy(drafts = if (text.isEmpty()) s.drafts - id else s.drafts + (id to text)) }

/** A published artifact's bytes (GET .../download, base64 on the wire). */
class ArtifactBytes(val name: String, val mimeType: String, val data: ByteArray)

/** The signed address of an HTML page on the separate artifact origin. [expiresAt] is an ISO instant. */
class RenderUrl(val url: String, val expiresAt: String?)

/** POST /v1/uploads: the file goes up first; the returned attachment is what a message carries (iOS `World.upload`). */
suspend fun World.upload(data: ByteArray, name: String, mimeType: String): Attachment {
    val api = api ?: throw ApiException.Http(401, "Sign in to attach files.")
    val raw = api.post("/v1/uploads", UploadBody(name, mimeType, Base64.encodeToString(data, Base64.NO_WRAP)))
    return runCatching { JunoJson.decodeFromString<Attachment>(raw) }.getOrNull()
        ?: JunoJson.decodeFromString<UploadEnvelope>(raw).attachment ?: throw ApiException.Http(500, "Unexpected server reply.")
}

/** GET /v1/artifacts/:id/versions/:v/download?part=file|preview|thumbnail. */
suspend fun World.artifactBytes(id: String, version: Int, part: String = "file"): ArtifactBytes {
    val api = api ?: throw ApiException.BadServer
    val reply = api.get<DownloadReply>("/v1/artifacts/$id/versions/$version/download?part=$part")
    return ArtifactBytes(reply.name, reply.mimeType, Base64.decode(reply.contentBase64, Base64.DEFAULT))
}

/** POST /v1/artifacts/:id/versions/:v/render-url: short-lived, no token is added to it. */
suspend fun World.artifactRenderUrl(id: String, version: Int): RenderUrl {
    val api = api ?: throw ApiException.BadServer
    val reply = JunoJson.decodeFromString<RenderReply>(api.post("/v1/artifacts/$id/versions/$version/render-url"))
    if (!reply.url.startsWith("https://") && !reply.url.startsWith("http://")) throw ApiException.BadServer
    return RenderUrl(reply.url, reply.expiresAt)
}

/** GET /v1/library/:id/download: any library file (also an approval's page screenshot). */
suspend fun World.libraryBytes(id: String): ArtifactBytes {
    val file = downloadLibraryFile(id)
    return ArtifactBytes(file.name, file.mimeType.orEmpty(), file.bytes)
}
