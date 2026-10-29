package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.App
import io.github.nigelleong0703.juno.contract.AppDetail
import io.github.nigelleong0703.juno.contract.Connection
import io.github.nigelleong0703.juno.contract.CreateMcpServerInput
import io.github.nigelleong0703.juno.contract.InstallAppCustomInput
import io.github.nigelleong0703.juno.contract.InstallAppResponse
import io.github.nigelleong0703.juno.contract.InstallAppWorkInput
import io.github.nigelleong0703.juno.contract.Skill
import io.github.nigelleong0703.juno.core.Api
import io.github.nigelleong0703.juno.core.ApiException
import io.github.nigelleong0703.juno.core.JunoJson
import io.github.nigelleong0703.juno.core.ListResponse
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.encodeToJsonElement

/** Where the server sends the browser after a connector sign-in (allow-listed server-side; iOS sends the same string). */
const val CONNECTOR_RETURN_URL = "juno://connectors"

@Serializable private class ConnectBody(val returnUrl: String? = null, val apiKey: String? = null)
@Serializable private class ReturnUrlBody(val returnUrl: String)
@Serializable private class PermissionBody(val permission: String)

/** Settings -> Connectors (iOS `World+Connectors.swift`). Plain calls; the caller re-reads the lists afterwards. */

/** The work/custom Apps catalog, projected for the existing Connectors page. */
suspend fun World.loadConnectorCatalog(): List<ConnectorView> =
    signedIn().get<ListResponse<App>>("/v1/apps").items.filter { it.category == "work" || it.category == "custom" }.map { it.connectorView() }

/** The owner's own MCP servers: connections without a catalogId (first page, as iOS reads it). */
suspend fun World.loadCustomConnections(): List<Connection> =
    signedIn().page<Connection>("/v1/connections").items.filter { it.catalogId == null }

/** One click for an OAuth connector: the sign-in page to open, or null when no login was needed. */
suspend fun World.connectConnector(id: String): String? {
    val raw = signedIn().post("/v1/apps/$id/install", InstallAppWorkInput(returnUrl = CONNECTOR_RETURN_URL))
    return JunoJson.decodeFromString<InstallAppResponse>(raw).openUrl
}

/** An API-key connector: the key is sent once and never read back. */
suspend fun World.connectApiKey(id: String, apiKey: String) {
    signedIn().post("/v1/apps/$id/install", InstallAppWorkInput(userConfig = mapOf("apiKey" to JunoJson.encodeToJsonElement(apiKey))))
}

suspend fun World.disconnectConnector(id: String) {
    val api = signedIn()
    val app = api.get<App>("/v1/apps/$id")
    for (installation in app.installations.orEmpty()) api.delete("/v1/apps/$id/installations/${installation.id}")
}

suspend fun World.connectorTools(id: String): List<ConnectorToolView> =
    signedIn().get<AppDetail>("/v1/apps/$id").capabilities.orEmpty().map { it.connectorTool() }

/** `permission` is `read_only` or `full`; it applies to the agent's next run. */
suspend fun World.setConnectionPermission(connectionId: String, permission: String) {
    signedIn().post("/v1/connections/$connectionId/permission", PermissionBody(permission))
}

/** Any remote MCP server by its address. */
suspend fun World.addCustomConnector(name: String, url: String) {
    signedIn().post("/v1/apps/custom/install", InstallAppCustomInput(name = name, transport = "http", url = url))
}

/** The sign-in page for a custom connection (or null), as [connectConnector] does for catalog connectors. */
suspend fun World.authorizeConnection(id: String): String? {
    val raw = signedIn().post("/v1/apps/custom/install", InstallAppCustomInput(connectionId = id, returnUrl = CONNECTOR_RETURN_URL))
    return JunoJson.decodeFromString<InstallAppResponse>(raw).openUrl
}

suspend fun World.disconnectConnection(id: String) {
    signedIn().delete("/v1/apps/custom/installations/$id")
}

/** Skills (GET /v1/skills), first 200 as iOS loads them. */
suspend fun World.loadSkills(): List<Skill> = signedIn().list<Skill>("/v1/skills?limit=200")

/** A skill's text is its active version's (contracts 0.61.0); an empty pointer shows nothing. */
val Skill.name: String? get() = active?.name
val Skill.description: String? get() = active?.description

/** A failure from a connector action that the user should see once (iOS `world.syncError`); cancellation is not shown. */
fun World.reportSyncError(e: Throwable) {
    if (!e.isCancellation) update { it.copy(syncError = e.userMessage) }
}

private fun World.signedIn(): Api = api ?: throw ApiException.NotSignedIn
