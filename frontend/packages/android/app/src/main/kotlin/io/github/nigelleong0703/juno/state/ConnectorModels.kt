package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.App
import io.github.nigelleong0703.juno.contract.AppCapability
import io.github.nigelleong0703.juno.contract.Connection

/** The old Connectors list's shape, projected from the 0.65 Apps catalog without redefining a public wire schema. */
data class ConnectorView(
    val id: String,
    val name: String,
    val description: String,
    val category: String?,
    val icon: String,
    val tier: String,
    val available: Boolean,
    val permission: String,
    val status: String,
    val apiKey: Boolean = false,
    val connectionId: String? = null,
)

data class ConnectorToolView(val name: String, val description: String, val kind: String?)

private object ConnectorPermissionValues {
    const val readOnly = "read_only"
    const val full = "full"
}

fun App.connectorView(): ConnectorView {
    val status = when {
        installations.orEmpty().isEmpty() -> "disconnected"
        installations.orEmpty().any { it.status == "connected" } -> "connected"
        installations.orEmpty().any { it.status == "expired" } -> "expired"
        else -> "error"
    }
    val tier = when {
        category == "custom" -> "custom"
        installations.orEmpty().isNotEmpty() -> "builtin"
        else -> "featured"
    }
    val permission = if (enabledAgents.orEmpty().any { it.actionsPolicy == "allow" }) ConnectorPermissionValues.full else ConnectorPermissionValues.readOnly
    return ConnectorView(id, name.orEmpty(), description.orEmpty(), group ?: category, icon.orEmpty(), tier, available != false, permission, status,
        apiKey = auth == "api_key", connectionId = installations.orEmpty().firstOrNull()?.id)
}

fun AppCapability.connectorTool() = ConnectorToolView(name.orEmpty(), title.orEmpty(), kind)

/**
 * The rules of the Connectors page (iOS `ConnectorsView`), kept pure so they can be tested: what is listed, how the
 * tiers group and cap, the search, and the default permission.
 */
object ConnectorRules {
    /** Rows per tier until "Show N more" (iOS `cap`). */
    const val TIER_CAP = 8

    /** The page's tiers, in page order. */
    val tiers = listOf("builtin", "featured", "custom")

    /** What the server cannot offer is not listed; its detail page still says so. */
    fun listed(all: List<ConnectorView>): List<ConnectorView> = all.filter { it.available }

    /** A connector without a tier counts as featured. */
    fun tierOf(connector: ConnectorView): String = connector.tier

    /** The category picker's entries, sorted. */
    fun categories(listed: List<ConnectorView>): List<String> = listed.mapNotNull { it.category }.distinct().sorted()

    /** Category filter (null = all) and a case-insensitive search over name and description. */
    fun matches(connector: ConnectorView, category: String?, query: String): Boolean {
        if (category != null && connector.category != category) return false
        if (query.isEmpty()) return true
        return connector.name.contains(query, ignoreCase = true) || connector.description.contains(query, ignoreCase = true)
    }

    /** One tier's connectors, in list order. */
    fun inTier(matched: List<ConnectorView>, tier: String): List<ConnectorView> = matched.filter { tierOf(it) == tier }

    /** The rows a tier shows: capped unless expanded, and search expands every tier. */
    fun visibleInTier(items: List<ConnectorView>, expanded: Boolean, searching: Boolean): List<ConnectorView> =
        if (expanded || searching) items else items.take(TIER_CAP)

    /** A catalog connector with no permission yet is read-only (iOS `ConnectorsView.swift:205`). */
    fun catalogPermission(connector: ConnectorView): String = connector.permission

    /** A custom connection with no permission is full (iOS `ConnectorsView.swift:293`). */
    fun customPermission(connection: Connection): String = ConnectorPermissionValues.full

    fun isConnected(status: String?): Boolean = status == "connected"

    /** Reconnect is offered for a lapsed or failed sign-in. */
    fun needsReconnect(status: String?): Boolean =
        status == "expired" || status == "error" || status == "needs_reauth"
}
