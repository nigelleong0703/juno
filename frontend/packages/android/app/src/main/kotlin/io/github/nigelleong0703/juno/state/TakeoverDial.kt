package io.github.nigelleong0703.juno.state

import kotlinx.coroutines.delay

/**
 * The take-over sequence (iOS `TakeoverView.task`): take over, then ask for a control ticket, up to [ATTEMPTS] times
 * waiting 400/800/1200 ms in between. The ticket must follow the server's confirmation: one asked for earlier is
 * issued view-only and every click is silently dropped, so each attempt takes over again before it asks.
 */
object TakeoverDial {
    const val ATTEMPTS = 3
    fun waitMs(attempt: Int): Long = 400L * (attempt + 1)

    suspend fun <T : Any> run(
        takeOver: suspend () -> Unit,
        ticket: suspend () -> T?,
        wait: suspend (Long) -> Unit = { delay(it) },
    ): T? {
        for (attempt in 0 until ATTEMPTS) {
            takeOver()
            ticket()?.let { return it }
            wait(waitMs(attempt))
        }
        return null
    }
}
