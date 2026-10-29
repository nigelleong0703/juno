package io.github.nigelleong0703.juno.ui.chat

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import java.io.File

/**
 * Voice input: an AAC clip in an MPEG-4 container (m4a, `audio/mp4`), at most two minutes, handed to
 * `World.transcribe`. The clip lives in the cache dir only until it is read.
 */
class Dictation(private val context: Context) {
    private var recorder: MediaRecorder? = null
    private var file: File? = null

    val recording: Boolean get() = recorder != null

    /** Starts recording; [onLimit] fires when the two-minute cap stops it. False when the microphone is unavailable. */
    fun start(onLimit: () -> Unit): Boolean {
        stopQuietly()
        val target = File(context.cacheDir, "dictation-${System.nanoTime()}.m4a")
        @Suppress("DEPRECATION")
        val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else MediaRecorder()
        return try {
            r.setAudioSource(MediaRecorder.AudioSource.MIC)
            r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            r.setAudioSamplingRate(16_000)
            r.setAudioEncodingBitRate(32_000)
            r.setMaxDuration(MAX_MS)
            r.setOnInfoListener { _, what, _ -> if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) onLimit() }
            r.setOutputFile(target.absolutePath)
            r.prepare()
            r.start()
            recorder = r
            file = target
            true
        } catch (e: Exception) {
            r.release()
            target.delete()
            false
        }
    }

    /** Stops and returns the clip, or null when nothing usable was recorded (stop right after start throws). */
    fun finish(): ByteArray? {
        val r = recorder ?: return null
        val f = file
        recorder = null; file = null
        val ok = runCatching { r.stop() }.isSuccess
        r.release()
        val bytes = if (ok) f?.readBytes() else null
        f?.delete()
        return bytes?.takeIf { it.isNotEmpty() }
    }

    fun cancel() = stopQuietly()

    private fun stopQuietly() {
        recorder?.let { runCatching { it.stop() }; it.release() }
        file?.delete()
        recorder = null; file = null
    }

    companion object { const val MAX_MS = 120_000 }
}
