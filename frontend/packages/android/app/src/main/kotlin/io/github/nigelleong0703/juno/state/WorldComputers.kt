package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.Computer
import io.github.nigelleong0703.juno.contract.ScreenResponse
import io.github.nigelleong0703.juno.contract.ScreenScreenshot
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import java.util.Base64

@Serializable private class AgentBody(val agentId: String)

private fun decodeBase64(text: String?): ByteArray? =
    text?.takeIf { it.isNotEmpty() }?.let { runCatching { Base64.getMimeDecoder().decode(it) }.getOrNull() }

/** GET /v1/computers. */
private suspend fun World.reloadComputers() {
    val api = api ?: return
    runCatching { api.list<Computer>("/v1/computers") }.onSuccess { list -> updateAgents { it.copy(computers = list, computersLoaded = true) } }
}

fun World.loadComputers() {
    scope.launch { reloadComputers() }
}

/** The agent's screen id (GET computers/default/agents/:id/screen), cached; null while it has no display. */
suspend fun World.screenId(agentId: String): String? {
    agentsData.value.screenIds[agentId]?.let { return it }
    val api = api ?: return null
    val screen = runCatching { api.get<ScreenResponse>("/v1/computers/default/agents/$agentId/screen") }.getOrNull() ?: return null
    updateAgents { it.copy(screenIds = it.screenIds + (agentId to screen.id)) }
    return screen.id
}

fun World.forgetScreen(agentId: String) = updateAgents { it.copy(screenIds = it.screenIds - agentId) }

/** One still of the agent's screen if it has a computer and a display (GET screens/:id/screenshot). */
suspend fun World.refreshScreen(agentId: String) {
    val api = api ?: return
    val id = screenId(agentId) ?: return
    val shot = runCatching { api.get<ScreenScreenshot>("/v1/screens/$id/screenshot") }.getOrNull() ?: return
    val bytes = decodeBase64(shot.data) ?: return
    updateAgents { it.copy(screenshots = it.screenshots + (agentId to Picture(bytes))) }
}

/**
 * The Start action of the computer panel: no computer -> ensure one, else allocate this agent's display on it.
 * Returns the server's message on failure, null on success.
 */
suspend fun World.startComputer(agentId: String): String? {
    val api = api ?: return null
    return try {
        val computer = agentsData.value.computer
        if (computer != null) api.post("/v1/computers/${computer.id}/screens", AgentBody(agentId)) else api.post("/v1/computers/ensure", AgentBody(agentId))
        forgetScreen(agentId)
        reloadComputers()
        refreshScreen(agentId)
        null
    } catch (e: Throwable) {
        if (e.isCancellation) throw e
        e.userMessage
    }
}

/** Gives control of the screen back to the agent (POST screens/:id/return-control, else the computer's route). Take-over is not ported. */
fun World.returnControl(agentId: String) {
    val computer = agentsData.value.computer ?: return
    updateAgents { d -> d.copy(computers = d.computers.mapIndexed { i, c -> if (i == 0) c.copy(controller = "agent") else c }) }
    remote { api ->
        val screen = screenId(agentId)
        api.post(if (screen != null) "/v1/screens/$screen/return-control" else "/v1/computers/${computer.id}/return-control")
    }
}

/** The screenshot an approval or step carries (a library image), cached. The download is JSON `{contentBase64}`. */
suspend fun World.previewImage(libraryId: String): Picture? {
    agentsData.value.previews[libraryId]?.let { return it }
    val bytes = runCatching { downloadLibraryFile(libraryId).bytes }.getOrNull()?.takeIf { it.isNotEmpty() } ?: return null
    val picture = Picture(bytes)
    updateAgents { it.copy(previews = it.previews + (libraryId to picture)) }
    return picture
}
