package io.github.nigelleong0703.juno.ui.chat

import android.graphics.Bitmap
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.artifactBytes
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * The PDF preview of a file artifact (iOS `PDFPreview`, the file/preview part): the pages rendered one under another,
 * scrollable, by the platform's PdfRenderer. Bytes come from the artifact part [part]; a failure says to download it.
 */
@Composable
fun PdfPreview(artifactId: String, version: Int, part: String) {
    val world = LocalWorld.current
    val c = JunoTheme.colors
    // null while loading; an empty list when the file could not be read or rendered.
    val pages by produceState<List<Bitmap>?>(null, artifactId, version, part) {
        value = try {
            withContext(Dispatchers.IO) { renderPages(world.artifactBytes(artifactId, version, part).data) }
        } catch (e: Throwable) {
            if (e is CancellationException) throw e
            emptyList()
        }
    }
    val list = pages
    Box(Modifier.fillMaxSize().background(c.canvas), contentAlignment = Alignment.Center) {
        when {
            list == null -> Text("Loading…", color = c.fgSubtle, style = junoText(TextSize.Sm))
            list.isEmpty() -> Text("Preview unavailable. Download the file to view it.", color = c.fgMuted, style = junoText(TextSize.Sm), modifier = Modifier.padding(16.dp))
            else -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(top = 56.dp)) {
                list.forEach { page ->
                    Image(
                        page.asImageBitmap(), contentDescription = null, contentScale = ContentScale.FillWidth,
                        modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
                    )
                }
            }
        }
    }
}

/** Renders each page at about twice the phone's width so text stays sharp when it is zoomed out. Caps at 40 pages. */
private fun renderPages(bytes: ByteArray): List<Bitmap> {
    val file = File.createTempFile("artifact-preview", ".pdf").apply { writeBytes(bytes); deleteOnExit() }
    ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
        PdfRenderer(fd).use { renderer ->
            return (0 until minOf(renderer.pageCount, 40)).map { i ->
                renderer.openPage(i).use { page ->
                    val scale = 1080f / page.width
                    val bitmap = Bitmap.createBitmap((page.width * scale).toInt(), (page.height * scale).toInt(), Bitmap.Config.ARGB_8888)
                    bitmap.eraseColor(android.graphics.Color.WHITE)
                    page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                    bitmap
                }
            }
        }
    }
}
