package io.github.nigelleong0703.juno.ui.settings.connectors

import android.content.Context
import io.github.nigelleong0703.juno.state.World
import io.github.nigelleong0703.juno.state.authorizeConnection
import io.github.nigelleong0703.juno.state.connectConnector
import io.github.nigelleong0703.juno.ui.components.openSignInPage

/** Connect a catalog connector, then open the sign-in page the server returns (if any). */
suspend fun World.connectWithBrowser(context: Context, connectorId: String) {
    connectConnector(connectorId)?.let { context.openSignInPage(it) }
}

/** Authorize a custom connection, then open its sign-in page (if any). */
suspend fun World.authorizeWithBrowser(context: Context, connectionId: String) {
    authorizeConnection(connectionId)?.let { context.openSignInPage(it) }
}
