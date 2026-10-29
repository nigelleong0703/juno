package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.Agent
import io.github.nigelleong0703.juno.contract.Conversation
import io.github.nigelleong0703.juno.contract.Request
import io.github.nigelleong0703.juno.contract.Run
import io.github.nigelleong0703.juno.core.Api
import io.github.nigelleong0703.juno.core.ApiException
import io.github.nigelleong0703.juno.core.Auth
import io.github.nigelleong0703.juno.core.EventStream
import io.github.nigelleong0703.juno.core.PushRegistrar
import io.github.nigelleong0703.juno.core.Session
import io.github.nigelleong0703.juno.core.SessionStore
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable

/**
 * The app-wide store (iOS `World`): one per process, created by [io.github.nigelleong0703.juno.JunoApplication] and handed to
 * Compose through [LocalWorld]. Screens read [state] and call the functions below; the server stays the source of truth
 * and the live event stream ([LiveEvents]) keeps [state] current. Mutations update [state] first, then tell the backend.
 *
 * Functions are grouped by file, all in this package (import them like `io.github.nigelleong0703.juno.state.send`):
 * WorldHistory (loading chats), WorldChat, WorldAgents, WorldRequests, WorldNavigation.
 *
 * Not ported yet (iOS World+*): Today, Feed, Library/Files, Connectors, Models, Channels, Calendar, Spaces, Artifacts,
 * Inspiration, Mac, Profile, Runs detail screens. The on-device copy is [LocalStore] (read at launch, written per load).
 */
class World(
    private val sessions: SessionStore,
    internal val scope: CoroutineScope,
    private val push: PushRegistrar = PushRegistrar.None,
    /** The on-device copy shown at launch (see [LocalStore]); null in tests. */
    private val local: LocalStore? = null,
) {
    private val _state = MutableStateFlow(WorldState())
    val state: StateFlow<WorldState> = _state.asStateFlow()

    /** Routines, goals, calendar, computers, Permissions data (see [AgentsData]); read with [agentsData]. */
    internal val agentsFlow = MutableStateFlow(AgentsData())

    private val _session = MutableStateFlow<Session?>(null)
    /** Null = signed out. The shell shows sign-in until this is set. */
    val session: StateFlow<Session?> = _session.asStateFlow()

    /** Signed-in backend; null before sign-in. */
    @Volatile internal var api: Api? = null
    private var streamJob: Job? = null
    @Volatile private var streamGeneration = 0L
    internal var markReadJob: Job? = null
    /** Feed undo window and Today debounce (WorldFeed / WorldToday). */
    internal val feature: FeatureRuntime by lazy { FeatureRuntime(this) }

    /** The app is in the foreground: an open chat's incoming items are read on arrival. Set by the shell from the lifecycle. */
    @Volatile var appActive = true

    internal fun update(change: (WorldState) -> WorldState) = _state.update(change)

    /** Launch: a stored login shows the app at once and connects in the background; being offline keeps it usable. */
    fun start() {
        val stored = sessions.load() ?: return
        _session.value = stored
        api = Api(stored)
        update { it.copy(selfId = stored.userId) }
        scope.launch { restore(stored) }
    }

    private suspend fun restore(session: Session) {
        // The last known lists and chats show before the network is touched; connect then refreshes them.
        local?.load(session)?.let { snapshot -> update { snapshot.applyTo(it) } }
        try {
            connect(session)
        } catch (e: Throwable) {
            if (e.isCancellation) return
            // Only a refused login ends the session; being offline keeps the app readable.
            if ((e as? ApiException)?.isUnauthorized == true) signOut()
            else { update { it.copy(syncError = e.userMessage) }; startStream(session, null) }
        }
    }

    suspend fun signIn(server: String, email: String, password: String) = accept(Auth.signIn(server, email, password))

    suspend fun signUp(server: String, name: String, email: String, password: String) = accept(Auth.signUp(server, name, email, password))

    private suspend fun accept(session: Session) {
        connect(session)
        sessions.save(session)
    }

    @Serializable private class Cursor(val after: Int)

    /** Loads the signed-in account's data, then follows the event stream. Throws when the first load fails. */
    suspend fun connect(session: Session) {
        val api = Api(session)
        this.api = api
        // Where live updates start: taken before the snapshot, so the stream only carries what happened since.
        val head = runCatching { api.get<Cursor>("/v1/events/cursor") }.getOrNull()
        val (agents, conversations, runs, requests) = coroutineScope {
            val agents = async { api.list<Agent>("/v1/agents?limit=200") }
            val conversations = async { api.list<Conversation>("/v1/conversations?limit=200") }
            val runs = async { api.list<Run>("/v1/runs?limit=200") }
            val requests = async { api.list<Request>("/v1/requests?limit=200") }
            Snapshot(agents.await(), conversations.await(), runs.await(), requests.await())
        }
        update { old ->
            old.copy(
                agents = agents, conversations = conversations, previews = emptyMap(), streaming = emptyMap(),
                // Housekeeping runs (memory jobs) are the agent's own upkeep: only a task's children are kept, by id.
                runs = runs.filter { it.kind != "background" },
                childRuns = runs.filter { it.kind == "background" && it.parentRunId != null }.associateBy { it.id },
                requests = requests, selfId = session.userId,
                currentConversationId = old.currentConversationId?.takeIf { id -> conversations.any { it.id == id } },
            )
        }
        _session.value = session
        persistLocal(api)
        loadFeatureLists()
        // Chats shown from the store are fetched again (their windows were stored); an open chat not stored loads now.
        val stored = _state.value.items.keys.toList()
        _state.value.currentConversationId?.let { loadItems(it) }
        scope.launch {
            stored.forEach { fetchNewest(it) }
            persistLocal(api)
        }
        startStream(session, head?.after)
        push.signedIn(api)
    }

    /** Writes the store after a successful load (iOS persistSnapshot). Off the caller's thread; skipped once signed out. */
    private fun persistLocal(api: Api) {
        val local = local ?: return
        scope.launch {
            local.save(api.session, LocalSnapshot.capture(_state.value)) { isCurrent(api) }
        }
    }

    private data class Snapshot(val agents: List<Agent>, val conversations: List<Conversation>, val runs: List<Run>, val requests: List<Request>)

    fun signOut() {
        push.signingOut()
        streamJob?.cancel()
        streamGeneration++
        sessions.save(null)
        api = null
        local?.clear()
        _session.value = null
        // The next account must not find anything of this one.
        _state.value = WorldState()
        agentsFlow.value = AgentsData()
    }

    internal fun startStream(session: Session, after: Int?) {
        streamJob?.cancel()
        val generation = ++streamGeneration
        streamJob = scope.launch {
            val stream = EventStream(session, after?.toString(), onLive = { live ->
                if (generation != streamGeneration) return@EventStream
                update { it.copy(streamLive = live) }
                // Every (re)connect re-reads the agents and requests: an event missed while the stream was down is never
                // replayed, so a card resolved meanwhile would stay pending (and counted in Needs you) for good.
                if (live) scope.launch { refreshAgents(); refreshRequests() }
            })
            stream.frames().collect { frame ->
                if (generation != streamGeneration) return@collect
                if (frame.isReset) handleReset() else applyFrame(frame.data)
            }
        }
    }

    /** Folds one raw event into [state], then does what an arriving item needs: an open chat is read as it arrives. */
    internal fun applyFrame(data: String) {
        val event = LiveEvents.parse(data) ?: return
        update { LiveEvents.apply(it, event) }
        agentsFlow.update { AgentEvents.apply(it, event) }
        with(LiveEvents) {
            afterFeatureEvent(event.text("type"))
            val chat = event.text("conversationId")
            if (event.text("type") == "item.added" && chat != null && chat == _state.value.currentConversationId && appActive) scheduleMarkRead(chat)
        }
    }

    /** The server's log no longer reaches our cursor: what is stored may have holes, so only the open chat is kept and re-fetched. */
    private suspend fun handleReset() {
        val open = _state.value.currentConversationId
        update { s ->
            s.copy(items = s.items.filterKeys { it == open }, history = s.history.filterKeys { it == open },
                pendingLive = emptyMap(), previews = emptyMap(), streaming = emptyMap())
        }
        refreshAgents()
        refreshRequests()
        open?.let { fetchNewest(it) }
    }

    /** Re-reads the requests: `request.resolved` can be missed like any event (see startStream). Server truth replaces local. */
    suspend fun refreshRequests() {
        val fresh = runCatching { api?.list<Request>("/v1/requests?limit=200") }.getOrNull() ?: return
        update { s -> s.copy(requests = fresh) }
    }

    /** Agent statuses are kept live by `agent.status` events, which a backgrounded app can miss: re-read on foreground and reconnect. */
    suspend fun refreshAgents() {
        val fresh = runCatching { api?.list<Agent>("/v1/agents?limit=200") }.getOrNull() ?: return
        // A "doing" line stays only for an agent that is still working.
        update { s -> s.copy(agents = fresh, doing = s.doing.filter { (id, _) -> fresh.any { it.id == id && it.status == "working" } }) }
    }

    /** Fire-and-forget backend call; a failure lands in [WorldState.syncError] (iOS `remote`). */
    internal fun remote(work: suspend (Api) -> Unit) {
        val api = api ?: return
        scope.launch {
            try { work(api) } catch (e: Throwable) { if (!e.isCancellation) update { it.copy(syncError = e.userMessage) } }
        }
    }



    /** True while [api] is still the session that started a long call: a sign-out or account switch in between voids its result. */
    internal fun isCurrent(api: Api) = this.api?.session == api.session
}
