package io.github.nigelleong0703.juno.ui.chat

import androidx.compose.foundation.layout.fillMaxSize
import io.github.nigelleong0703.juno.ui.components.BytesImage
import androidx.compose.ui.layout.ContentScale
import io.github.nigelleong0703.juno.ui.components.JunoIcons
import io.github.nigelleong0703.juno.ui.components.Hairline
import io.github.nigelleong0703.juno.ui.components.MarkdownText
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Item
import io.github.nigelleong0703.juno.contract.LibraryItem
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.state.ArtifactBytes
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.artifactBytes
import io.github.nigelleong0703.juno.state.reloadLibrary
import io.github.nigelleong0703.juno.state.libraryBytes
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private fun LibraryItem.isMarkdown() = mimeType == "text/markdown" || name?.endsWith(".md") == true

/** An `artifact` transcript item (spec 2.5): published page / image / video / other, else a plain file card. */
@Composable
fun ArtifactItemCard(item: Item, lib: LibraryItem?, libraryAgentName: String?) {
    val world = LocalWorld.current
    val id = item.artifactId ?: return
    // The library list is fetched once; an artifact created since (artifact.updated is not folded in) triggers a reload.
    LaunchedEffect(id, lib == null) { if (lib == null) world.reloadLibrary() }
    if (lib == null) return
    when {
        // TODO(spaces): `render == "app"` is the iOS SpaceCard (open button into the Space); Spaces are not ported.
        lib.render == "app" -> FileCard(lib, subtitle = "App")
        // iOS fileMeta: the author is the agent that made the file (createdByAgentId), "You" when none.
        lib.render != null -> PublishedArtifactCard(lib, item.version?.toInt() ?: lib.version?.toInt() ?: 1, libraryAgentName)
        else -> FileCard(lib)
    }
}

/** Fetches an artifact part off the main thread; [attempt] bumps to retry. */
@Composable
fun rememberArtifactBytes(id: String, version: Int, part: String, attempt: Int = 0): Loaded<ArtifactBytes> {
    val world = LocalWorld.current
    val state by produceState<Loaded<ArtifactBytes>>(Loaded.Loading, id, version, part, attempt) {
        value = try { Loaded.Ready(withContext(Dispatchers.IO) { world.artifactBytes(id, version, part) }) } catch (e: Throwable) { if (e.isCancellation) throw e; Loaded.Failed }
    }
    return state
}

private fun renderIcon(lib: LibraryItem): ImageVector = when (lib.render) {
    "html" -> JunoIcons.Globe; "image" -> JunoIcons.Photo; "video" -> JunoIcons.Video; else -> JunoIcons.File
}

@Composable
private fun CardFrame(content: @Composable () -> Unit) {
    val c = JunoTheme.colors
    val shape = RoundedCornerShape(Radius.card)
    Column(Modifier.fillMaxWidth().widthIn(max = 560.dp).clip(shape).background(c.requestCard).border(0.5.dp, c.border, shape)) { content() }
}

/** iOS `icon(_:)`: by render first, then by kind. */
private fun artifactIcon(lib: LibraryItem): ImageVector = when (lib.render) {
    "html" -> JunoIcons.Computer; "app" -> JunoIcons.Grid; "video" -> JunoIcons.Video
    else -> when (lib.kind) { "image" -> JunoIcons.Photo; "spreadsheet" -> JunoIcons.Table; "code" -> JunoIcons.Terminal; else -> JunoIcons.File }
}

/** iOS `fileTypeLine`: the extension (or mime subtype) in caps and the size; `Markdown`/`Text` for .md/.txt. */
fun fileTypeLine(lib: LibraryItem): String {
    val ext = if (lib.name?.contains('.') == true) lib.name.orEmpty().substringAfterLast('.').lowercase() else ""
    val type = when (ext) {
        "md", "markdown" -> "Markdown"; "txt" -> "Text"
        "" -> lib.mimeType?.substringAfterLast('/') ?: lib.kind
        else -> ext
    }
    return listOfNotNull(type?.uppercase(), ChatFormat.bytes(lib.sizeBytes).takeIf { it.isNotEmpty() }).joinToString(" · ")
}

/** iOS `fileMeta`: the type line, then the author (the agent's name, or "You"). */
fun fileMeta(lib: LibraryItem, agentName: String?): String =
    listOf(fileTypeLine(lib), agentName ?: "You").filter { it.isNotEmpty() }.joinToString(" · ")

@Composable
private fun HeaderRow(lib: LibraryItem, subtitle: String, trailing: @Composable () -> Unit = {}) {
    val c = JunoTheme.colors
    // iOS header: a 36pt tile (bgSubtle, radius lg), name medium 2 lines, subtitle xs, padding 12 / 10.
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(36.dp).clip(RoundedCornerShape(Radius.lg)).background(c.bgSubtle), contentAlignment = Alignment.Center) {
            Icon(artifactIcon(lib), null, tint = c.fgMuted, modifier = Modifier.size(17.dp))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(lib.name.orEmpty(), color = c.fg, style = junoText(TextSize.Base, FontWeight.Medium), maxLines = 2)
            Text(subtitle, color = c.fgSubtle, style = junoText(TextSize.Xs), maxLines = 1)
        }
        trailing()
    }
}

/** A plain file in the transcript: icon, name, size; the footer saves it. */
@Composable
fun FileCard(lib: LibraryItem, subtitle: String? = null) {
    val world = LocalWorld.current
    CardFrame {
        HeaderRow(lib, subtitle ?: listOfNotNull(lib.mimeType, lib.sizeBytes?.let { ChatFormat.bytes(it) }).joinToString(" · "))
        DownloadFooter(lib.name ?: "file", lib.mimeType) { world.libraryBytes(lib.id) }
    }
}

@Composable
fun PublishedArtifactCard(lib: LibraryItem, latest: Int, agentName: String?) {
    val world = LocalWorld.current
    val c = JunoTheme.colors
    var version by remember(lib.id, latest) { mutableIntStateOf(latest) }
    var menu by remember { mutableStateOf(false) }
    var full by remember { mutableStateOf(false) }
    var image by remember { mutableStateOf<ByteArray?>(null) }
    val versions = lib.versions.orEmpty().mapNotNull { it.version?.toInt() }.sortedDescending()
    val size = lib.versions?.firstOrNull { it.version?.toInt() == version }?.sizeBytes ?: lib.sizeBytes
    // iOS PublishedArtifactCard.subtitle: an html page reads "Interactive page · size"; any other file its fileMeta.
    val subtitle = if (lib.render == "html" && size != null) "Interactive page · ${ChatFormat.bytes(size)}"
        else if (lib.render == "html") "Interactive page" else fileMeta(lib, agentName)
    CardFrame {
        HeaderRow(lib, subtitle) {
            if (versions.size > 1) Box {
                CardChip("v$version" + if (version == latest) " · updated" else "", onClick = { menu = true })
                DropdownMenu(menu, { menu = false }) {
                    versions.forEach { v -> DropdownMenuItem(text = { Text("v$v") }, onClick = { version = v; menu = false }) }
                }
            }
            // A single version is a plain muted label at the right (iOS `Text("v\(shown)")`).
            else Text("v$version", color = JunoTheme.colors.fgSubtle, style = junoText(TextSize.Xs))
        }
        Hairline()
        when {
            lib.render == "html" -> {
                SandboxedPage(lib.id, version, Modifier.fillMaxWidth().height(420.dp))
                Row(Modifier.padding(10.dp)) { CardChip("Open full screen", onClick = { full = true }) }
                if (full) FullScreen({ full = false }) { SandboxedPage(lib.id, version, Modifier.fillMaxWidth().padding(top = 56.dp)) }
            }
            lib.render == "image" -> ImageBody(lib.id, version) { image = it }
            lib.isMarkdown() -> MarkdownBody(lib.id, version)
            // TODO(media3): video (spec: 240dp player) needs Media3; the footer still saves it.
            lib.render == "video" -> Text("Video: save it to watch.", color = c.fgMuted, style = junoText(TextSize.Sm), modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp))
            else -> FileBody(lib, version)
        }
        DownloadFooter(lib.name ?: "artifact", lib.mimeType) { world.artifactBytes(lib.id, version) }
    }
    image?.let { ImageViewer(it) { image = null } }
}

/**
 * A file that is not a page, picture or text (iOS `ArtifactFileBody`): its thumbnail when it has one, and a Preview
 * button when it has a preview (a PDF, or the file's own preview part). Preview opens the PDF pages full screen.
 */
@Composable
private fun FileBody(lib: LibraryItem, version: Int) {
    val c = JunoTheme.colors
    val info = lib.versions?.firstOrNull { it.version?.toInt() == version }
    val isPdf = info?.mimeType == "application/pdf"
    val previewPart = when { isPdf -> "file"; info?.previewRef != null -> "preview"; else -> null }
    val thumb = if (info?.thumbnailRef != null) (rememberArtifactBytes(lib.id, version, "thumbnail") as? Loaded.Ready)?.value?.data else null
    var previewing by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(bottom = 4.dp)) {
        Box(Modifier.fillMaxWidth().height(132.dp).background(c.bgSubtle.copy(alpha = 0.5f)), contentAlignment = Alignment.Center) {
            if (thumb != null) BytesImage(thumb, cacheKey = "artifact:${lib.id}:$version:thumb", modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
            else Icon(artifactIcon(lib), null, tint = c.fgSubtle, modifier = Modifier.size(36.dp))
        }
        if (previewPart != null) Row(Modifier.padding(horizontal = 8.dp)) { CardChip("Preview", icon = JunoIcons.Eye, onClick = { previewing = true }) }
    }
    if (previewing && previewPart != null) FullScreen({ previewing = false }) { PdfPreview(lib.id, version, previewPart) }
}

@Composable
private fun ImageBody(id: String, version: Int, onOpen: (ByteArray) -> Unit) {
    var attempt by remember { mutableIntStateOf(0) }
    val bytes = rememberArtifactBytes(id, version, "file", attempt)
    val picture = (bytes as? Loaded.Ready)?.value?.data
    if (picture != null) InlineImage(picture, "artifact:$id:$version", 320.dp, Modifier.clickable { onOpen(picture) })
    else Box(Modifier.fillMaxWidth().height(160.dp).background(JunoTheme.colors.tile).clickable(enabled = bytes is Loaded.Failed) { attempt++ }, contentAlignment = Alignment.Center) {
        Text(if (bytes is Loaded.Failed) "Couldn't load. Tap to retry." else "Loading…", color = JunoTheme.colors.fgSubtle, style = junoText(TextSize.Sm))
    }
}

/** Markdown inline, clipped at 240dp when long (over 600 chars or 12 lines) with a "Show more" toggle. */
@Composable
private fun MarkdownBody(id: String, version: Int) {
    val c = JunoTheme.colors
    val bytes = rememberArtifactBytes(id, version, "file")
    val text = (bytes as? Loaded.Ready)?.value?.data?.toString(Charsets.UTF_8) ?: return
    val long = text.length > 600 || text.count { it == '\n' } > 12
    var expanded by remember(text) { mutableStateOf(false) }
    Column(Modifier.padding(14.dp)) {
        MarkdownText(text, c.fg, Modifier.then(if (long && !expanded) Modifier.heightIn(max = 240.dp) else Modifier), TextSize.Base)
        if (long) Text(if (expanded) "Show less" else "Show more", color = c.fg, style = junoText(TextSize.Sm, FontWeight.Medium), modifier = Modifier.padding(top = 6.dp).clickable { expanded = !expanded })
    }
}

/** "Download": the Storage Access Framework save dialog (no storage permission, no FileProvider needed). */
@Composable
private fun DownloadFooter(name: String, mime: String?, fetch: suspend () -> ArtifactBytes) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var pending by remember { mutableStateOf<ArtifactBytes?>(null) }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(mime ?: "application/octet-stream")) { uri ->
        val data = pending ?: return@rememberLauncherForActivityResult
        pending = null
        if (uri != null) scope.launch(Dispatchers.IO) { runCatching { context.contentResolver.openOutputStream(uri)?.use { it.write(data.data) } } }
    }
    Hairline()
    // iOS footer: a ghost sm button with the download glyph, right-aligned, padding 8 / 4.
    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), horizontalArrangement = Arrangement.End) {
        Row(
            Modifier.clip(CircleShape).clickable {
                scope.launch {
                    runCatching { withContext(Dispatchers.IO) { fetch() } }.onSuccess { pending = it; save.launch(name) }
                }
            }.padding(horizontal = 12.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(JunoIcons.Download, null, tint = JunoTheme.colors.fg, modifier = Modifier.size(14.dp))
            Text("Download", color = JunoTheme.colors.fg, style = junoText(TextSize.Sm, FontWeight.Medium))
        }
    }
}
