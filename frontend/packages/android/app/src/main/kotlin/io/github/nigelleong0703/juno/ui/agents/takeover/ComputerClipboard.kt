package io.github.nigelleong0703.juno.ui.agents.takeover

import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import androidx.core.content.FileProvider
import io.github.nigelleong0703.juno.contract.ScreenClipboardPaste
import io.github.nigelleong0703.juno.core.ApiException
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException

/**
 * The computer clipboard on Android (M-CLIP): text keeps the VNC path; an image or files travel through computerd.
 * The device side lives here: reading what the device clipboard holds, putting a copied image or file on it, and the
 * messages for a refused call. Byte work runs off the main thread (callers use `Dispatchers.IO`).
 */

/** The upload limit of one clipboard item; the server refuses more (413). */
const val CLIPBOARD_LIMIT = 10 * 1024 * 1024

/** The most files one paste carries. */
private const val MAX_FILES = 10

const val COMPUTER_CLIPBOARD_FAILED = "The clipboard could not be moved. Try again."

/** What this device's clipboard holds for the computer. */
sealed interface DevicePaste {
    data class Text(val text: String) : DevicePaste
    data class Send(val input: ScreenClipboardPaste) : DevicePaste
    data object Empty : DevicePaste
    data object TooLarge : DevicePaste
}

private class ClipboardTooLarge : Exception()

/**
 * What the device clipboard holds: files first (a copied file can carry a thumbnail image), then an image (PNG or JPEG as they
 * are, other formats re-encoded as PNG), then text. Files together stay under the upload limit.
 */
fun readDeviceClipboard(context: Context): DevicePaste = try {
    readClipboard(context)
} catch (tooLarge: ClipboardTooLarge) {
    DevicePaste.TooLarge
}

private fun readClipboard(context: Context): DevicePaste {
    val clip = (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip ?: return DevicePaste.Empty
    val resolver = context.contentResolver
    val uris = (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
    val files = uris.filter { !isImage(resolver.getType(it)) }.take(MAX_FILES)
    if (files.isNotEmpty()) {
        var total = 0
        val items = files.map { uri ->
            val bytes = readBounded(resolver, uri, CLIPBOARD_LIMIT - total)
            total += bytes.size
            ScreenClipboardPaste.File(name = displayName(resolver, uri), contentBase64 = base64(bytes))
        }
        return DevicePaste.Send(ScreenClipboardPaste(kind = "files", files = items))
    }
    val image = uris.firstOrNull { isImage(resolver.getType(it)) }
    if (image != null) {
        val type = resolver.getType(image)
        val bytes = readBounded(resolver, image, CLIPBOARD_LIMIT)
        if (type == "image/png" || type == "image/jpeg") {
            return DevicePaste.Send(ScreenClipboardPaste(kind = "image", mimeType = type, contentBase64 = base64(bytes)))
        }
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return DevicePaste.Empty
        val png = ByteArrayOutputStream().use { out ->
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            out.toByteArray()
        }
        if (png.size > CLIPBOARD_LIMIT) return DevicePaste.TooLarge
        return DevicePaste.Send(ScreenClipboardPaste(kind = "image", mimeType = "image/png", contentBase64 = base64(png)))
    }
    val text = runCatching { clip.getItemAt(0).coerceToText(context)?.toString() }.getOrNull()
    return if (text.isNullOrEmpty()) DevicePaste.Empty else DevicePaste.Text(text)
}

private fun isImage(mime: String?): Boolean = mime?.startsWith("image/") == true

private fun base64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

/** The bytes of one item, refused past [limit] (a huge file is never read into memory). */
private fun readBounded(resolver: ContentResolver, uri: Uri, limit: Int): ByteArray {
    val input = resolver.openInputStream(uri) ?: throw IOException("the clipboard item cannot be opened")
    input.use { stream ->
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val read = stream.read(buffer)
            if (read < 0) break
            if (out.size() + read > limit) throw ClipboardTooLarge()
            out.write(buffer, 0, read)
        }
        return out.toByteArray()
    }
}

private fun displayName(resolver: ContentResolver, uri: Uri): String {
    val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getString(0) else null
    }
    return name ?: uri.lastPathSegment ?: "file"
}

/** Writes [bytes] under `cache/juno-files/<name>` (the name reduced to its last segment) and returns its FileProvider URI. */
private fun Context.cachedUri(name: String, bytes: ByteArray): Uri {
    val dir = File(cacheDir, "juno-files").apply { mkdirs() }
    val safe = name.substringAfterLast('/').substringAfterLast('\\').ifBlank { "file" }
    val file = File(dir, safe).also { it.writeBytes(bytes) }
    return FileProvider.getUriForFile(this, "$packageName.files", file)
}

/** Text from the computer on this device's clipboard. */
fun Context.putTextOnClipboard(text: String) {
    (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Juno", text))
}

/** A copied image on this device's clipboard, as a content URI the paste target reads through the grant. */
fun Context.putImageOnClipboard(bytes: ByteArray) {
    val uri = cachedUri("computer-clipboard.png", bytes)
    (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newUri(contentResolver, "Juno", uri))
}

/** A copied file, offered to the system share sheet (which includes saving it). */
fun Context.shareComputerFile(name: String, bytes: ByteArray) {
    val uri = cachedUri(name, bytes)
    val share = Intent(Intent.ACTION_SEND)
        .setType("application/octet-stream")
        .putExtra(Intent.EXTRA_STREAM, uri)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    startActivity(Intent.createChooser(share, name))
}

/** What a failed clipboard call says: the take-over rule and the size limit are named, anything else is a retry. */
fun computerClipboardMessage(error: Throwable): String = when ((error as? ApiException)?.httpStatus) {
    409 -> "Take over the computer first to copy or paste"
    413 -> "That is larger than the 10 MB limit"
    else -> COMPUTER_CLIPBOARD_FAILED
}

/** The HTTP status of a refused call, when the error carries one. */
internal val ApiException.httpStatus: Int?
    get() = when (this) {
        is ApiException.Http -> status
        is ApiException.Api -> status
        else -> null
    }
