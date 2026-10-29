package io.github.nigelleong0703.juno.state

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The "Not interested" undo window (iOS `World+Feed.dismissPost`). A dismissal is sent to the server only when its
 * [WINDOW_MS] runs out, or at once when another dismissal starts (that one flushes first). [undo] inside the window
 * takes it back and nothing is sent. Pure timing, so it is unit-tested with virtual time.
 */
class FeedUndo(
    private val scope: CoroutineScope,
    private val windowMs: Long = WINDOW_MS,
    private val onFlush: (FeedDismissal) -> Unit,
) {
    private var pending: FeedDismissal? = null
    private var timer: Job? = null

    /** The dismissal waiting for its window, if any. */
    val current: FeedDismissal? get() = pending

    fun begin(dismissal: FeedDismissal) {
        flush()
        pending = dismissal
        timer = scope.launch {
            delay(windowMs)
            // Only the timer of the dismissal still pending may flush it (a newer one has its own timer).
            if (pending?.id == dismissal.id) take()?.let(onFlush)
        }
    }

    /** Takes back the pending dismissal; null when none is waiting. */
    fun undo(): FeedDismissal? {
        timer?.cancel()
        timer = null
        return pending.also { pending = null }
    }

    /** Sends the pending dismissal now, if one is waiting. */
    fun flush() {
        timer?.cancel()
        timer = null
        take()?.let(onFlush)
    }

    private fun take(): FeedDismissal? = pending.also { pending = null }

    companion object {
        const val WINDOW_MS = 5_000L
    }
}
