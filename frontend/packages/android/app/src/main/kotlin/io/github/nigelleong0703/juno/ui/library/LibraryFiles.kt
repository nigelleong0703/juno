package io.github.nigelleong0703.juno.ui.library

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import io.github.nigelleong0703.juno.state.LibraryFile
import io.github.nigelleong0703.juno.core.parseIso
import java.io.File

/**
 * Writes a downloaded library file to the app cache and opens it with another app through a FileProvider grant (iOS
 * opens it in QuickLook). With no app able to open it, the system share sheet is offered instead.
 */
fun Context.openLibraryFile(file: LibraryFile) {
    val target = cachedFile(file)
    val uri = FileProvider.getUriForFile(this, "$packageName.files", target)
    val view = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, file.mimeType?.takeIf { it.isNotBlank() } ?: "*/*")
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    try {
        startActivity(view)
    } catch (_: ActivityNotFoundException) {
        val share = Intent(Intent.ACTION_SEND)
            .setType(file.mimeType?.takeIf { it.isNotBlank() } ?: "*/*")
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        startActivity(Intent.createChooser(share, file.name))
    }
}

/** `cache/juno-files/<name>`: the name is reduced to its last segment, so a download can never write outside the folder. */
internal fun Context.cachedFile(file: LibraryFile): File {
    val dir = File(cacheDir, "juno-files").apply { mkdirs() }
    val safe = file.name.substringAfterLast('/').substringAfterLast('\\').ifBlank { "file" }
    return File(dir, safe).also { it.writeBytes(file.bytes) }
}

/**
 * iOS `RelativeDateTimeFormatter` (short) for a library row: "9 min. ago", "2 hr. ago", "3 days ago". Under a minute
 * it says "now", as the formatter does.
 */
internal fun libraryAgo(iso: String?, now: java.time.Instant = java.time.Instant.now()): String {
    val at = parseIso(iso) ?: return ""
    val s = maxOf(0L, now.epochSecond - at.epochSecond)
    val day = 86_400L
    return when {
        s < 60 -> "now"
        s < 3_600 -> "${s / 60} min. ago"
        s < day -> "${s / 3_600} hr. ago"
        s < day * 30 -> "${s / day} ${if (s / day == 1L) "day" else "days"} ago"
        else -> "${s / (day * 30)} mo. ago"
    }
}
