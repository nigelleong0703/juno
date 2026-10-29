package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.nav.Route
import java.net.URI
import java.net.URLDecoder

/** How a connector sign-in ended, from the server's `status` query value. Missing or unknown counts as [Unknown]. */
enum class ConnectorStatus { Connected, Failed, Unknown }

/** The `juno://connectors?connection=<id>&status=...` link the server redirects to after a connector sign-in. */
data class ConnectorReturn(val connectionId: String?, val status: ConnectorStatus)

/**
 * Parses an incoming link. Null unless it is `juno://connectors` (scheme and host, case-insensitive); the server
 * allow-lists that exact string, so nothing else is treated as a return.
 */
fun parseConnectorReturn(link: String?): ConnectorReturn? {
    if (link.isNullOrBlank()) return null
    val uri = runCatching { URI(link.trim()) }.getOrNull() ?: return null
    if (!uri.scheme.equals("juno", ignoreCase = true) || !uri.host.equals("connectors", ignoreCase = true)) return null
    val params = parseQuery(uri.rawQuery)
    val status = when (params["status"]) {
        "connected" -> ConnectorStatus.Connected
        "error" -> ConnectorStatus.Failed
        else -> ConnectorStatus.Unknown
    }
    return ConnectorReturn(connectionId = params["connection"]?.takeIf { it.isNotBlank() }, status = status)
}

/**
 * Shows the Connectors page after a sign-in browser hands back. The page re-reads its lists on resume, which is when
 * the activity comes back to the foreground after the return intent. A failed sign-in gets the sync-error alert;
 * success and unknown outcomes need no message, the refreshed list shows the new state. Ignored when signed out.
 */
fun World.connectorReturned(ret: ConnectorReturn) {
    if (session.value == null) return
    if (ret.status == ConnectorStatus.Failed) update { it.copy(syncError = "The connection didn't finish. Try again from Connectors.") }
    open(Route.Plugins())
}

/** `a=1&b=x%20y` to a map; a repeated key keeps its first value, a key without `=` maps to "". */
private fun parseQuery(raw: String?): Map<String, String> {
    if (raw.isNullOrEmpty()) return emptyMap()
    val out = LinkedHashMap<String, String>()
    for (pair in raw.split('&')) {
        if (pair.isEmpty()) continue
        val key = URLDecoder.decode(pair.substringBefore('='), Charsets.UTF_8.name())
        val value = URLDecoder.decode(pair.substringAfter('=', ""), Charsets.UTF_8.name())
        out.putIfAbsent(key, value)
    }
    return out
}
