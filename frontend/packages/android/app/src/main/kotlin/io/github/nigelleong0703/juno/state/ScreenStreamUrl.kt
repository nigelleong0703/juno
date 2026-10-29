package io.github.nigelleong0703.juno.state

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.net.URI

/**
 * Validates a live-screen stream ticket and pins it to the signed-in server (iOS `World.streamURL`, web
 * `normalizeScreenStreamTicket`). The issued host is advisory: agentd reports its loopback address, so only the
 * ticket's path and query are kept and the scheme, host and port come from the server we are signed in to.
 */
object ScreenStreamUrl {
    /**
     * The websocket URL to dial, or null when the ticket is unusable: a path that is not this screen's `/vnc`, or a
     * view-only ticket when [control] was asked for (it looks fine and silently drops every click; the caller retries).
     */
    fun pin(ticketUrl: String, ticketControl: Boolean?, control: Boolean, screenId: String, server: String): String? {
        if (control && ticketControl != true) return null
        val issued = runCatching { URI(ticketUrl) }.getOrNull() ?: return null
        val path = issued.rawPath ?: return null
        if (path != "/v1/screens/$screenId/vnc") return null
        val base = server.trim().toHttpUrlOrNull() ?: return null
        val pinned = base.newBuilder().encodedPath(path).encodedQuery(issued.rawQuery).fragment(null).build().toString()
        // http -> ws, https -> wss
        return "ws" + pinned.removePrefix("http")
    }
}
