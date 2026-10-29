package io.github.nigelleong0703.juno.ui.chat

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import android.Manifest
import io.github.nigelleong0703.juno.ui.components.AgentAvatar
import android.content.ContentValues
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
import androidx.core.app.ActivityCompat
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import io.github.nigelleong0703.juno.contract.Agent
import io.github.nigelleong0703.juno.contract.Item
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/**
 * The message capsule (spec 3): "+" for Camera / Photos / Files, a 1-6 line field, and one trailing button that is mic,
 * send, stop or a spinner by [ComposerModel.trailing]. Flat composer surface with a hairline (no glass), 28dp from the
 * screen sides at rest and 16dp while focused.
 */
@Composable
fun Composer(c: ComposerController, roomAgents: List<Agent>, replySender: (Item) -> String, modifier: Modifier = Modifier) {
    val colors = JunoTheme.colors
    val context = LocalContext.current
    val model = c.model
    var focused by remember { mutableStateOf(false) }
    var choosing by remember { mutableStateOf(false) }
    val side by animateDpAsState(if (focused) 16.dp else 28.dp, tween(250), label = "side")
    val pickers = rememberAttachmentPickers(c)
    val haptic = LocalHapticFeedback.current
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> if (granted) c.startDictation() }
    // The rationale comes first only after a denial (Android says so); a first ask goes straight to the system dialog.
    var micRationale by remember { mutableStateOf(false) }
    val isRoom = roomAgents.isNotEmpty()
    val query = if (isRoom) Mentions.activeQuery(model.text) else null

    Column(modifier.padding(horizontal = side).padding(top = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (query != null) MentionPicker(roomAgents, query) { handle, mention -> c.pickMention(handle, mention) }
        else if (isRoom && model.canSend && Mentions.build(model.text, emptyList()).isEmpty() && !model.text.contains('@')) {
            Text("Mention an agent to get a reply", color = colors.fgMuted, style = junoText(TextSize.Xs), modifier = Modifier.padding(horizontal = 8.dp))
        }
        c.replyTo?.let { ReplyChip(replySender(it), Quote.split(it.text ?: it.markdown.orEmpty()).body) { c.replyTo = null } }
        c.error?.let { Text(it, color = JunoStatus.danger, style = junoText(TextSize.Xs), modifier = Modifier.padding(horizontal = 8.dp)) }
        Column(
            Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp).clip(RoundedCornerShape(Radius.composerGrown)).background(colors.composer)
                .border(0.5.dp, colors.composerEdge, RoundedCornerShape(Radius.composerGrown)),
        ) {
            if (model.files.isNotEmpty()) Row(Modifier.horizontalScroll(rememberScrollState()).padding(start = 10.dp, end = 10.dp, top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                model.files.forEach { AttachmentTile(it, onRetry = { c.retryUpload(it.localId) }, onRemove = { c.remove(it.localId) }) }
            }
            Row(Modifier.padding(6.dp), verticalAlignment = Alignment.Bottom) {
                RoundButton(JunoIcons.Plus, "Add", enabled = model.canAttachMore, iconSize = 17.dp) { choosing = true }
                BasicTextField(
                    value = model.text, onValueChange = c::setText, minLines = 1, maxLines = 6,
                    textStyle = junoText(TextSize.Lg).copy(color = colors.fg), cursorBrush = SolidColor(colors.fg),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    modifier = Modifier.weight(1f).defaultMinSize(minHeight = 36.dp).padding(horizontal = 6.dp).onFocusChanged { focused = it.isFocused },
                    decorationBox = { inner ->
                        Box(Modifier.defaultMinSize(minHeight = 36.dp), contentAlignment = Alignment.CenterStart) {
                            if (model.text.isEmpty()) Text("Message…", color = colors.fgSubtle, style = junoText(TextSize.Lg))
                            inner()
                        }
                    },
                )
                when (model.trailing) {
                    Trailing.Mic -> RoundButton(JunoIcons.Mic, "Dictate", iconSize = 16.dp) {
                        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                        val activity = context.findActivity()
                        when {
                            granted -> c.startDictation()
                            activity != null && ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.RECORD_AUDIO) -> micRationale = true
                            else -> micPermission.launch(Manifest.permission.RECORD_AUDIO)
                        }
                    }
                    Trailing.Stop -> RoundButton(JunoIcons.Waveform, "Stop dictating", tint = colors.primaryFg, fill = colors.primary) { c.stopDictation() }
                    Trailing.Transcribing -> Box(Modifier.size(36.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = colors.fgMuted) }
                    // iOS send: a 38x28 capsule, solid primary when sendable, the muted token (grey glyph) when not.
                    Trailing.Send -> Box(
                        Modifier.size(width = 38.dp, height = 28.dp).clip(RoundedCornerShape(50)).background(if (model.canSend) colors.primary else colors.muted)
                            .clickable(enabled = model.canSend) { haptic.performHapticFeedback(HapticFeedbackType.Confirm); c.send() },
                        contentAlignment = Alignment.Center,
                    ) { Icon(JunoIcons.ArrowUp, "Send", tint = if (model.canSend) colors.primaryFg else colors.fgMuted, modifier = Modifier.size(16.dp)) }
                }
            }
        }
    }
    if (choosing) ChatSheet({ choosing = false }, "Add") {
        SheetRow(JunoIcons.Camera, "Camera") { choosing = false; pickers.camera() }
        SheetRow(JunoIcons.Photo, "Photos") { choosing = false; pickers.photos() }
        SheetRow(JunoIcons.File, "Files") { choosing = false; pickers.files() }
    }
    if (micRationale) AlertDialog(
        onDismissRequest = { micRationale = false },
        title = { Text("Allow the microphone?") },
        text = { Text("Juno listens only while you dictate, then turns your speech into text in the message box.") },
        confirmButton = { TextButton({ micRationale = false; micPermission.launch(Manifest.permission.RECORD_AUDIO) }) { Text("Continue") } },
        dismissButton = { TextButton({ micRationale = false }) { Text("Not now") } },
    )
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

@Composable
private fun RoundButton(
    icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, enabled: Boolean = true, iconSize: Dp = 20.dp,
    tint: androidx.compose.ui.graphics.Color = JunoTheme.colors.fg, fill: androidx.compose.ui.graphics.Color = JunoTheme.colors.muted, onClick: () -> Unit,
) {
    // iOS roundGlyph: a 36pt circle on the muted token, the glyph centred.
    Box(
        Modifier.size(36.dp).clip(CircleShape).background(fill).alpha(if (enabled) 1f else 0.4f).clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, label, tint = tint, modifier = Modifier.size(iconSize)) }
}

@Composable
private fun SheetRow(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = JunoTheme.colors.fg)
        Text(title, color = JunoTheme.colors.fg, style = junoText(TextSize.Lg))
    }
}

/** A 64dp attachment tile: the preview or a document tile; dimmed spinner while uploading, red "!" when it failed (tap retries), x removes. */
@Composable
private fun AttachmentTile(file: ComposerFile, onRetry: () -> Unit, onRemove: () -> Unit) {
    val c = JunoTheme.colors
    Box(Modifier.size(width = 64.dp, height = 72.dp).padding(top = 8.dp, end = 8.dp)) {
        Box(Modifier.size(64.dp).clip(RoundedCornerShape(Radius.md)).background(c.tile), contentAlignment = Alignment.Center) {
            val thumb = file.thumbnail
            if (thumb != null) androidx.compose.foundation.Image(thumb.asImageBitmap(), null, Modifier.size(64.dp).alpha(if (file.status == UploadStatus.Ready) 1f else 0.5f), contentScale = ContentScale.Crop)
            else Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(if (file.isImage) JunoIcons.Photo else JunoIcons.File, null, tint = c.fgMuted)
                Text(file.name, color = c.fgMuted, style = junoText(TextSize.Xxs), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 4.dp))
            }
            when (file.status) {
                UploadStatus.Uploading -> CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = c.fg)
                UploadStatus.Failed -> Icon(JunoIcons.Alert, "Retry upload", tint = JunoStatus.danger, modifier = Modifier.size(26.dp).clickable(onClick = onRetry))
                UploadStatus.Ready -> Unit
            }
        }
        Box(Modifier.align(Alignment.TopEnd).size(20.dp).clip(CircleShape).background(c.primary).clickable(onClick = onRemove), contentAlignment = Alignment.Center) {
            Icon(JunoIcons.Close, "Remove", tint = c.primaryFg, modifier = Modifier.size(12.dp))
        }
    }
}

/** The reply chip above the field: sender name, one line of the quoted text, and an x. */
@Composable
private fun ReplyChip(sender: String, text: String, onClear: () -> Unit) {
    val c = JunoTheme.colors
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.lg)).background(c.muted).padding(start = 12.dp, top = 6.dp, bottom = 6.dp, end = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(width = 3.dp, height = 28.dp).background(c.fgSubtle, CircleShape))
        Column(Modifier.weight(1f)) {
            Text(sender, color = c.fg, style = junoText(TextSize.Xs, FontWeight.SemiBold), maxLines = 1)
            Text(text, color = c.fgMuted, style = junoText(TextSize.Sm), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Icon(JunoIcons.Close, "Cancel reply", tint = c.fgMuted, modifier = Modifier.size(32.dp).clip(CircleShape).clickable(onClick = onClear).padding(8.dp))
    }
}

/** The suggestion list above the composer: "All" first, then the room's agents (iOS `MentionPicker`). */
@Composable
private fun MentionPicker(agents: List<Agent>, query: String, pick: (String, io.github.nigelleong0703.juno.contract.Mention) -> Unit) {
    val c = JunoTheme.colors
    val q = query.lowercase()
    val rows = if (q.isEmpty()) agents else agents.filter { Mentions.handle(it).lowercase().startsWith(q) || (it.name ?: "").lowercase().startsWith(q) }
    val showAll = q.isEmpty() || Mentions.aliases.any { it.startsWith(q) }
    if (!showAll && rows.isEmpty()) return
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.tile)).background(c.card).border(0.5.dp, c.border, RoundedCornerShape(Radius.tile)).heightIn(max = 220.dp).verticalScroll(rememberScrollState()),
    ) {
        if (showAll) MentionRow(null, "All", "Everyone in this chat") { pick("all", io.github.nigelleong0703.juno.contract.Mention(kind = "agent", id = "all", label = "@all")) }
        rows.forEach { agent ->
            MentionRow(agent, agent.name ?: agent.id, agent.title.orEmpty()) {
                val h = Mentions.handle(agent)
                pick(h, io.github.nigelleong0703.juno.contract.Mention(kind = "agent", id = agent.id, label = "@$h"))
            }
        }
    }
}

@Composable
private fun MentionRow(agent: Agent?, title: String, subtitle: String, onClick: () -> Unit) {
    val c = JunoTheme.colors
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        if (agent != null) AgentAvatar(agent, 28.dp, animated = false) else Box(Modifier.size(28.dp).background(c.muted, CircleShape))
        Column {
            Text(title, color = c.fg, style = junoText(TextSize.Sm, FontWeight.Medium))
            if (subtitle.isNotEmpty()) Text(subtitle, color = c.fgMuted, style = junoText(TextSize.Xs), maxLines = 1)
        }
    }
}

/** The three attachment launchers: camera (full-size via MediaStore on Q+), photo picker (5 max) and any file. */
class AttachmentPickers(val camera: () -> Unit, val photos: () -> Unit, val files: () -> Unit)

@Composable
private fun rememberAttachmentPickers(c: ComposerController): AttachmentPickers {
    val context = LocalContext.current
    var cameraUri by remember { mutableStateOf<Uri?>(null) }
    val take = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok -> if (ok) cameraUri?.let { c.addUris(listOf(it)) } }
    val preview = rememberLauncherForActivityResult(ActivityResultContracts.TakePicturePreview()) { bmp -> bmp?.let { c.addBitmap(it, "Photo") } }
    val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(ComposerModel.MAX_FILES)) { c.addUris(it) }
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { c.addUris(it) }
    return AttachmentPickers(
        camera = {
            if (Build.VERSION.SDK_INT >= 29) {
                val values = ContentValues().apply { put(MediaStore.Images.Media.DISPLAY_NAME, "juno-${System.currentTimeMillis()}.jpg"); put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg") }
                val uri = context.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
                cameraUri = uri
                if (uri != null) take.launch(uri) else preview.launch(null)
            } else preview.launch(null)
        },
        photos = { photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
        files = { files.launch(arrayOf("*/*")) },
    )
}
