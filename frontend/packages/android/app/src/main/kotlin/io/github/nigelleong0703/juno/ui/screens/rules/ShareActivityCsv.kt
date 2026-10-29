package io.github.nigelleong0703.juno.ui.screens.rules

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import java.io.File

/**
 * Writes the activity CSV to the app cache and offers it to the system share sheet (iOS shares the same file). The cache folder
 * `juno-files/` is the one the FileProvider already exposes, so nothing else is shared.
 */
fun Context.shareActivityCsv(text: String) {
    val dir = File(cacheDir, "juno-files").apply { mkdirs() }
    val file = File(dir, "juno-activity.csv").also { it.writeText(text) }
    val uri = FileProvider.getUriForFile(this, "$packageName.files", file)
    val share = Intent(Intent.ACTION_SEND)
        .setType("text/csv")
        .putExtra(Intent.EXTRA_STREAM, uri)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    startActivity(Intent.createChooser(share, "juno-activity.csv"))
}
