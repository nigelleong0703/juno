package io.github.nigelleong0703.juno.ui.chat

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.provider.OpenableColumns
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.github.nigelleong0703.juno.contract.Item
import io.github.nigelleong0703.juno.contract.Mention
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage
import io.github.nigelleong0703.juno.state.World
import io.github.nigelleong0703.juno.state.send
import io.github.nigelleong0703.juno.state.transcribe
import io.github.nigelleong0703.juno.state.upload
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.util.UUID

/**
 * The composer's behaviour around [ComposerModel]: attachments (compress, upload, retry), dictation, the reply quote and
 * the final send. UI-agnostic; [Composer] only draws it.
 */
class ComposerController(
    private val chatId: String,
    private val world: World,
    private val context: Context,
    private val scope: CoroutineScope,
    initialText: String,
) {
    var model by mutableStateOf(ComposerModel(text = initialText))
        private set
    /** A short failure to show under the field (dictation or upload); cleared by the next action. */
    var error by mutableStateOf<String?>(null)
        private set
    /** The message being replied to: its quote goes in front of the text. */
    var replyTo by mutableStateOf<Item?>(null)

    private val picked = ArrayList<Mention>()
    private val prepared = HashMap<String, Pair<String, Prepared>>()
    private val dictation = Dictation(context)

    fun setText(text: String) { model = model.copy(text = text) }

    fun pickMention(handle: String, mention: Mention) {
        if (mention.id != "all") picked += mention
        setText(Mentions.completing(model.text, handle))
    }

    // --- Attachments ---
    fun addUris(uris: List<Uri>) {
        for (uri in uris.take(ComposerModel.MAX_FILES - model.files.size)) scope.launch {
            val read = withContext(Dispatchers.IO) { runCatching { readUri(uri) }.getOrNull() }
            if (read == null) { error = "Couldn't read that file."; return@launch }
            enqueue(read.first, read.second, read.third)
        }
    }

    fun addBitmap(bitmap: Bitmap, name: String) {
        if (!model.canAttachMore) return
        scope.launch {
            val bytes = withContext(Dispatchers.Default) { ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it) }.toByteArray() }
            enqueue(name, "image/jpeg", bytes)
        }
    }

    private suspend fun enqueue(name: String, mime: String, bytes: ByteArray) {
        val ready = withContext(Dispatchers.Default) { ImageCompressor.prepare(bytes, mime) }
        if (!model.canAttachMore) return
        val id = UUID.randomUUID().toString()
        prepared[id] = name to ready
        model = model.copy(files = model.files + ComposerFile(id, name, ready.mimeType, UploadStatus.Uploading, thumbnail = ready.thumbnail))
        upload(id)
    }

    private fun upload(id: String) {
        val (name, file) = prepared[id] ?: return
        model = model.updateFile(id) { it.copy(status = UploadStatus.Uploading) }
        scope.launch {
            try {
                val attachment = world.upload(file.bytes, name, file.mimeType)
                model = model.updateFile(id) { it.copy(status = UploadStatus.Ready, attachment = attachment) }
            } catch (e: Throwable) {
                if (e.isCancellation) throw e
                error = e.userMessage
                model = model.updateFile(id) { it.copy(status = UploadStatus.Failed) }
            }
        }
    }

    fun retryUpload(id: String) { error = null; upload(id) }

    fun remove(id: String) { prepared.remove(id); model = model.copy(files = model.files.filter { it.localId != id }) }

    private fun readUri(uri: Uri): Triple<String, String, ByteArray> {
        val resolver = context.contentResolver
        val mime = resolver.getType(uri) ?: "application/octet-stream"
        val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null } ?: "File"
        val bytes = resolver.openInputStream(uri)?.use { it.readBytes() } ?: error("unreadable")
        return Triple(name, mime, bytes)
    }

    // --- Dictation ---
    /** Starts recording (the caller already has the microphone permission). */
    fun startDictation() {
        error = null
        if (dictation.start(onLimit = { stopDictation() })) model = model.copy(dictation = DictationPhase.Recording)
        else error = "Couldn't start the microphone."
    }

    fun stopDictation() {
        if (model.dictation != DictationPhase.Recording) return
        val clip = dictation.finish()
        if (clip == null) { model = model.copy(dictation = DictationPhase.Idle); return }
        model = model.copy(dictation = DictationPhase.Transcribing)
        scope.launch {
            try { model = model.withTranscript(world.transcribe(clip)) }
            catch (e: Throwable) {
                if (e.isCancellation) throw e
                error = e.userMessage
                model = model.copy(dictation = DictationPhase.Idle)
            }
        }
    }

    // --- Send ---
    fun send() {
        if (!model.canSend) return
        val body = model.text.trim()
        val quote = replyTo?.let { Quote.prefix(it.text ?: it.markdown.orEmpty()) }.orEmpty()
        world.send(quote + body, chatId, model.files.mapNotNull { it.attachment }, Mentions.build(body, picked))
        model = ComposerModel()
        replyTo = null
        picked.clear(); prepared.clear(); error = null
    }

    fun dispose() { dictation.cancel() }
}
