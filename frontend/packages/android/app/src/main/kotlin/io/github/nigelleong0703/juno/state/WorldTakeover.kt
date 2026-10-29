package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.Request
import io.github.nigelleong0703.juno.contract.ScreenClipboard
import io.github.nigelleong0703.juno.contract.ScreenClipboardPaste
import io.github.nigelleong0703.juno.contract.ScreenClipboardPasteResult
import io.github.nigelleong0703.juno.contract.ScreenElements
import io.github.nigelleong0703.juno.core.ApiException
import io.github.nigelleong0703.juno.core.JunoJson
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.nowIso
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

@Serializable private class StreamBody(val control: Boolean)

/**
 * Takes over and waits until the server has it (unlike a fire-and-forget switch): a control stream ticket asked for
 * before this lands is issued view-only. Returns whether the server confirmed. The local controller flips at once.
 */
suspend fun World.takeOver(agentId: String): Boolean {
    val api = api ?: return false
    val screen = screenId(agentId) ?: return false
    updateAgents { d -> d.copy(computers = d.computers.mapIndexed { i, c -> if (i == 0) c.copy(controller = "user") else c }) }
    return try { api.post("/v1/screens/$screen/take-over"); true } catch (e: Throwable) { if (e.isCancellation) throw e; false }
}

/** A signed websocket URL for the live screen (POST screens/:id/stream), validated and pinned to our server; null when unusable. */
suspend fun World.streamUrl(agentId: String, control: Boolean): String? {
    val api = api ?: return null
    val screen = screenId(agentId) ?: return null
    val raw = try { api.post("/v1/screens/$screen/stream", StreamBody(control)) } catch (e: Throwable) { if (e.isCancellation) throw e; return null }
    val ticket = runCatching { Json.parseToJsonElement(raw) as JsonObject }.getOrNull() ?: return null
    val url = ticket["url"]?.jsonPrimitive?.contentOrNull ?: return null
    return ScreenStreamUrl.pin(url, ticket["control"]?.jsonPrimitive?.booleanOrNull, control, screen, api.session.server)
}

/** What the computer's clipboard holds after the user's Ctrl+C (GET screens/:id/clipboard); only while the user controls the screen (409 otherwise). */
suspend fun World.copyComputerClipboard(agentId: String): ScreenClipboard {
    val api = api ?: throw ApiException.NotSignedIn
    val screen = screenId(agentId) ?: throw ApiException.NotSignedIn
    return api.get<ScreenClipboard>("/v1/screens/$screen/clipboard")
}

/** Puts an image or files on the computer (POST screens/:id/clipboard); the reply says where they went. */
suspend fun World.pasteComputerClipboard(agentId: String, input: ScreenClipboardPaste): ScreenClipboardPasteResult {
    val api = api ?: throw ApiException.NotSignedIn
    val screen = screenId(agentId) ?: throw ApiException.NotSignedIn
    return JunoJson.decodeFromString(api.post("/v1/screens/$screen/clipboard", input))
}

/** Tap targets (GET screens/:id/elements); the server answers only while the user controls the screen (409 otherwise). */
suspend fun World.screenElements(agentId: String): ScreenElements? {
    val api = api ?: return null
    val screen = screenId(agentId) ?: return null
    return try { api.get<ScreenElements>("/v1/screens/$screen/elements") } catch (e: Throwable) { if (e.isCancellation) throw e; null }
}

/** "Done" in a take-over: marks the agent's pending computer request approved locally, then hands the screen back. */
fun World.returnControl(request: Request) {
    update { s -> s.copy(requests = s.requests.map { if (it.id == request.id && it.status == "pending") it.copy(status = "approved", resolvedAt = nowIso()) else it }) }
    request.agentId?.let { returnControl(it) }
}
