package io.github.nigelleong0703.juno.ui.chat

/**
 * Paging and anchoring decisions of the transcript, kept pure. The list is a reversed LazyColumn: index 0 is the newest
 * entry (at the bottom), the highest index the oldest.
 */
object TranscriptMath {
    /** The reader may be this far from the newest row (dp) and still count as "at the bottom". */
    const val JUMP_THRESHOLD_DP = 140f

    /** Older rows are requested once the reader is within this many screens of the oldest row. */
    const val PAGING_SCREENS = 1.5f

    /** Request the next older page when the last visible row is within 1.5 screens of the oldest. */
    fun shouldLoadOlder(lastVisibleIndex: Int, visibleCount: Int, total: Int): Boolean {
        if (total == 0 || visibleCount == 0) return false
        val lookahead = Math.ceil((PAGING_SCREENS * visibleCount).toDouble()).toInt()
        return lastVisibleIndex >= total - 1 - lookahead
    }

    /** Jump-to-latest shows when the reader is far from the newest row or the window was trimmed at its newest end. */
    fun showJump(distanceFromNewestDp: Float, detached: Boolean): Boolean = detached || distanceFromNewestDp > JUMP_THRESHOLD_DP

    fun atBottom(firstVisibleIndex: Int, firstVisibleOffsetPx: Int, density: Float): Boolean =
        firstVisibleIndex == 0 && firstVisibleOffsetPx / density <= JUMP_THRESHOLD_DP

    /**
     * A new newest row: my own message always scrolls to the bottom; other rows only when the reader is already there.
     * A reader scrolled up keeps their place (the lazy list holds the first visible row by key).
     */
    fun followNewest(previousNewestId: String?, newestId: String?, newestIsMine: Boolean, wasAtBottom: Boolean): Boolean =
        newestId != null && newestId != previousNewestId && (newestIsMine || wasAtBottom)
}

/** Composer trailing button: what it does for the current draft. */
enum class Trailing { Mic, Send, Stop, Transcribing }

enum class DictationPhase { Idle, Recording, Transcribing }

enum class UploadStatus { Uploading, Ready, Failed }

/** One attachment tile above the text. [attachment] is the server's record once uploaded. */
data class ComposerFile(
    val localId: String,
    val name: String,
    val mimeType: String,
    val status: UploadStatus,
    val attachment: io.github.nigelleong0703.juno.contract.Attachment? = null,
    val thumbnail: android.graphics.Bitmap? = null,
) {
    val isImage get() = mimeType.startsWith("image/")
}

/** The composer's state machine (spec section 3): which trailing button shows and whether a message can go out. */
data class ComposerModel(
    val text: String = "",
    val files: List<ComposerFile> = emptyList(),
    val dictation: DictationPhase = DictationPhase.Idle,
) {
    val trailing: Trailing
        get() = when {
            dictation == DictationPhase.Recording -> Trailing.Stop
            dictation == DictationPhase.Transcribing -> Trailing.Transcribing
            text.isNotBlank() || files.isNotEmpty() -> Trailing.Send
            else -> Trailing.Mic
        }

    /** Send is disabled while any attachment is still uploading, and a failed one blocks it until retried or removed. */
    val canSend: Boolean
        get() = trailing == Trailing.Send && files.none { it.status != UploadStatus.Ready } && (text.isNotBlank() || files.isNotEmpty())

    val canAttachMore: Boolean get() = files.size < MAX_FILES

    fun withTranscript(spoken: String): ComposerModel {
        val clean = spoken.trim()
        if (clean.isEmpty()) return copy(dictation = DictationPhase.Idle)
        return copy(text = if (text.isBlank()) clean else text.trimEnd() + " " + clean, dictation = DictationPhase.Idle)
    }

    fun updateFile(localId: String, change: (ComposerFile) -> ComposerFile) = copy(files = files.map { if (it.localId == localId) change(it) else it })

    companion object { const val MAX_FILES = 5 }
}

/** Typing presence: at most one `true` per second while typing, a trailing `false` when the draft empties or is sent. */
class TypingGate(private val minIntervalMs: Long = 1000) {
    private var active = false
    private var lastSentAt = Long.MIN_VALUE

    /** Returns the value to report now, or null when nothing should be sent. */
    fun onDraft(text: String, nowMs: Long): Boolean? {
        val typing = text.isNotBlank()
        return when {
            typing && (!active || nowMs - lastSentAt >= minIntervalMs) -> { active = true; lastSentAt = nowMs; true }
            !typing && active -> { active = false; false }
            else -> null
        }
    }
}
