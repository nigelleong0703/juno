package io.github.nigelleong0703.juno.ui.settings.connectors

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.nigelleong0703.juno.contract.Connection
import io.github.nigelleong0703.juno.state.ConnectorView
import io.github.nigelleong0703.juno.contract.Skill
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage
import io.github.nigelleong0703.juno.state.World
import io.github.nigelleong0703.juno.state.loadConnectorCatalog
import io.github.nigelleong0703.juno.state.loadCustomConnections
import io.github.nigelleong0703.juno.state.loadSkills
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * The Connectors and Skills lists, kept across rotation. A failed load keeps what was known; the lists are re-read on
 * resume, because a sign-in finishes in the browser and the app only sees the result when it comes back.
 */
class PluginsModel(private val world: World) : ViewModel() {
    private val _connectors = MutableStateFlow<List<ConnectorView>?>(null)
    /** Null until the first catalog load lands. */
    val connectors: StateFlow<List<ConnectorView>?> = _connectors.asStateFlow()

    private val _connections = MutableStateFlow<List<Connection>>(emptyList())
    /** The owner's custom MCP servers. */
    val connections: StateFlow<List<Connection>> = _connections.asStateFlow()

    private val _skills = MutableStateFlow<List<Skill>?>(null)
    val skills: StateFlow<List<Skill>?> = _skills.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    /** Why the last read failed, for the list to show in place of its content. */
    val error: StateFlow<String?> = _error.asStateFlow()

    /** Re-reads the catalog and the custom servers (iOS `refreshConnectors`). */
    fun refresh() {
        viewModelScope.launch { reload() }
    }

    fun refreshSkills() {
        viewModelScope.launch {
            try {
                _skills.value = world.loadSkills()
            } catch (e: Throwable) {
                fail(e)
            }
        }
    }

    /**
     * Runs one change (connect, disconnect, permission, add), then re-reads the lists as iOS does in `defer`. [onDone]
     * gets the message to show, or null when the change went through.
     */
    fun perform(work: suspend (World) -> Unit, onDone: (String?) -> Unit) {
        viewModelScope.launch {
            val failure = try {
                work(world)
                null
            } catch (e: Throwable) {
                if (e.isCancellation) null else e.userMessage
            }
            reload()
            onDone(failure)
        }
    }

    private suspend fun reload() {
        _error.value = null
        try {
            _connectors.value = world.loadConnectorCatalog()
        } catch (e: Throwable) {
            fail(e)
        }
        try {
            _connections.value = world.loadCustomConnections()
        } catch (e: Throwable) {
            fail(e)
        }
    }

    private fun fail(e: Throwable) {
        if (e.isCancellation) throw e
        _error.value = e.userMessage
    }
}
