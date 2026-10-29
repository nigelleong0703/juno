package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.FileDownload
import io.github.nigelleong0703.juno.contract.LibraryItem
import io.github.nigelleong0703.juno.core.ApiException
import io.github.nigelleong0703.juno.core.JunoJson
import kotlinx.serialization.Serializable
import java.util.Base64

/** Where a library item is listed. Uploads are not the agent's and never appear. */
enum class LibraryGroup(val title: String) {
    Tools("Tools"), Documents("Documents"), Media("Media");

    companion object {
        /** Interactive pages and apps are tools; pictures and video are media; any other file the agent made is a document. */
        fun of(item: LibraryItem): LibraryGroup? {
            if (item.source == "upload") return null
            if (item.render == "html" || item.render == "app") return Tools
            val mime = item.mimeType.orEmpty()
            if (item.render == "image" || item.render == "video" || item.kind == "image" || mime.startsWith("image/") || mime.startsWith("video/")) return Media
            return Documents
        }
    }
}

/** A downloaded library file: its name and bytes, as the server sent them. */
class LibraryFile(val name: String, val mimeType: String?, val bytes: ByteArray)

/** GET /v1/library?limit=200 (sign-in and refresh). */
suspend fun World.reloadLibrary() {
    val api = api ?: return
    val list = runCatching { api.list<LibraryItem>("/v1/library?limit=200") }.getOrNull() ?: return
    update { it.copy(library = list) }
}

/** GET /v1/library/:id/download: `{name, mimeType, contentBase64}`. */
suspend fun World.downloadLibraryFile(id: String, fallbackName: String? = null): LibraryFile {
    val api = api ?: throw ApiException.NotSignedIn
    val file = api.get<FileDownload>("/v1/library/$id/download")
    val bytes = Base64.getMimeDecoder().decode(file.contentBase64.orEmpty())
    return LibraryFile(name = file.name?.takeIf { it.isNotBlank() } ?: fallbackName ?: "file", mimeType = file.mimeType, bytes = bytes)
}

/** The signed address of a published page (http or https). Opened in the browser, never with the session token. */
suspend fun World.artifactRenderUrl(item: LibraryItem): String {
    return artifactRenderUrl(item.id, (item.version ?: 1).toInt()).url
}
