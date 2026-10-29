package io.github.nigelleong0703.juno.ui.settings.channels

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.nigelleong0703.juno.contract.ConnectChannelInput
import io.github.nigelleong0703.juno.core.ApiException
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage
import io.github.nigelleong0703.juno.state.ChannelPlatform
import io.github.nigelleong0703.juno.state.ChannelConnectReply
import io.github.nigelleong0703.juno.state.ConnectFailure
import io.github.nigelleong0703.juno.state.World
import io.github.nigelleong0703.juno.state.connectChannel
import io.github.nigelleong0703.juno.state.connectFailureOf
import io.github.nigelleong0703.juno.state.connectLink
import io.github.nigelleong0703.juno.state.newChannelOf
import io.github.nigelleong0703.juno.state.refreshChannels
import io.github.nigelleong0703.juno.state.saveSlackConfigToken
import io.github.nigelleong0703.juno.state.slackConfigTokenConfigured
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Where the connect flow is (iOS `Phase`). */
sealed interface FlowPhase {
    data object Choose : FlowPhase
    data object Own : FlowPhase
    data object Token : FlowPhase
    data object SlackConfig : FlowPhase
    data class SlackManual(val channelId: String, val manifest: String) : FlowPhase
    data class Waiting(val url: String?) : FlowPhase
    data class Code(val reply: ChannelConnectReply) : FlowPhase
}

/**
 * The flow's screen state. The secret fields (bot token, app secret, signing secret, Slack config tokens) are write-only:
 * they live here, never in saved state, and are blanked once the server has them or when the flow closes.
 */
data class ChannelFlowState(
    val phase: FlowPhase = FlowPhase.Choose,
    val busy: Boolean = false,
    val error: String? = null,
    val domain: String = ConnectChannelInput.DomainValue.feishu,
    val botToken: String = "",
    val signingSecret: String = "",
    val appId: String = "",
    val appSecret: String = "",
    val configToken: String = "",
    val configRefresh: String = "",
)

/**
 * One platform's connect flow (iOS `ChannelFlow`). Requests go through the [World] channel functions; after a connect that
 * needs the user elsewhere (Telegram, a shared Slack or Discord app, Feishu) the flow polls the channel list until a new
 * channel of this kind appears, or gives up after [POLL_TRIES] tries.
 */
class ChannelFlowViewModel(
    private val world: World,
    private val agentId: String,
    private val platform: ChannelPlatform,
) : ViewModel() {
    private val _state = MutableStateFlow(ChannelFlowState())
    val state: StateFlow<ChannelFlowState> = _state.asStateFlow()

    /** Links the screen should open in a browser (the waiting step opens its link by itself). */
    private val _links = Channel<String>(Channel.BUFFERED)
    val links: Flow<String> = _links.receiveAsFlow()

    /** Channel ids of every channel the agent had when the flow opened: the ones this flow does not create. */
    private val before: Deferred<Set<String>> = viewModelScope.async {
        runCatching { world.refreshChannels(agentId) }.getOrNull()?.map { it.id }?.toSet().orEmpty()
    }
    private var pollJob: Job? = null

    fun edit(change: (ChannelFlowState) -> ChannelFlowState) = _state.update(change)

    fun connectPrimary() = launchFlow { start(primaryInput()) }

    fun connectElsewhere() = launchFlow { start(ConnectChannelInput(mode = ConnectChannelInput.ModeValue.oauth)) }

    /** Discord goes straight to the token form; the other platforms list their own-bot paths. */
    fun showOwn() = _state.update { it.copy(phase = if (platform == ChannelPlatform.Discord) FlowPhase.Token else FlowPhase.Own) }

    fun showToken() = _state.update { it.copy(phase = FlowPhase.Token) }

    /** Slack: one-tap app creation needs the configuration token; without it the flow asks for one first. */
    fun createSlackForMe() = launchFlow {
        if (world.slackConfigTokenConfigured()) start(ConnectChannelInput(mode = ConnectChannelInput.ModeValue.manifest))
        else _state.update { it.copy(phase = FlowPhase.SlackConfig) }
    }

    fun prepareSlack() = launchFlow {
        val reply = world.connectChannel(agentId, platform.kind, ConnectChannelInput(mode = ConnectChannelInput.ModeValue.prepare))
        _state.update { it.copy(phase = FlowPhase.SlackManual(reply.channelId.orEmpty(), reply.manifest.orEmpty())) }
    }

    fun submitToken() {
        val s = _state.value
        launchFlow {
            start(
                if (platform == ChannelPlatform.Feishu) ConnectChannelInput(appId = s.appId.trim(), appSecret = s.appSecret.trim(), domain = s.domain)
                else ConnectChannelInput(botToken = s.botToken.trim()),
            )
        }
    }

    fun saveSlackConfig() {
        val s = _state.value
        launchFlow {
            world.saveSlackConfigToken(s.configToken.trim(), s.configRefresh.trim())
            _state.update { it.copy(configToken = "", configRefresh = "") }
            start(ConnectChannelInput(mode = ConnectChannelInput.ModeValue.manifest))
        }
    }

    fun submitSlackManual(channelId: String) {
        val s = _state.value
        launchFlow {
            start(
                ConnectChannelInput(
                    mode = ConnectChannelInput.ModeValue.manual, botToken = s.botToken.trim(),
                    channelId = channelId, signingSecret = s.signingSecret.trim(),
                ),
            )
        }
    }

    /** One step back; from the first step the screen closes the sheet instead. */
    fun back() {
        val phase = _state.value.phase
        val target = when (phase) {
            FlowPhase.Own, is FlowPhase.Waiting -> FlowPhase.Choose
            FlowPhase.Token -> if (platform == ChannelPlatform.Discord) FlowPhase.Choose else FlowPhase.Own
            FlowPhase.SlackConfig, is FlowPhase.SlackManual -> FlowPhase.Own
            else -> return
        }
        pollJob?.cancel()
        _state.update { it.copy(phase = target, error = null) }
    }

    /** The sheet closed: stop polling and blank every secret the flow held. */
    fun close() {
        pollJob?.cancel()
        _state.value = ChannelFlowState(domain = _state.value.domain)
    }

    private fun primaryInput(): ConnectChannelInput = when (platform) {
        ChannelPlatform.Telegram -> ConnectChannelInput(mode = ConnectChannelInput.ModeValue.managed)
        ChannelPlatform.Slack, ChannelPlatform.Discord -> ConnectChannelInput(mode = ConnectChannelInput.ModeValue.oauth)
        ChannelPlatform.Feishu -> ConnectChannelInput(mode = ConnectChannelInput.ModeValue.register, domain = _state.value.domain)
    }

    /** Sends one connect request and moves to whatever the platform needs next. */
    private suspend fun start(input: ConnectChannelInput) {
        val reply = world.connectChannel(agentId, platform.kind, input)
        _state.update { it.copy(botToken = "", signingSecret = "", appSecret = "") }
        val link = connectLink(reply)
        // No channel yet but something to do elsewhere: wait for the channel to appear (a manual connect returns it directly).
        val waiting = reply.channel == null && (reply.pending != null || link != null)
        if (waiting) waitFor(link) else _state.update { it.copy(phase = FlowPhase.Code(reply)) }
    }

    private fun waitFor(link: String?) {
        link?.let { _links.trySend(it) }
        _state.update { it.copy(phase = FlowPhase.Waiting(link)) }
        pollJob?.cancel()
        pollJob = viewModelScope.launch { pollUntilConnected() }
    }

    private suspend fun pollUntilConnected() {
        val existing = before.await()
        repeat(POLL_TRIES) {
            delay(POLL_MS)
            val channels = runCatching { world.refreshChannels(agentId) }.getOrNull() ?: return@repeat
            newChannelOf(channels, platform, existing)?.let { channel ->
                _state.update { it.copy(phase = FlowPhase.Code(ChannelConnectReply(channel = channel))) }
                return
            }
        }
        _state.update { it.copy(phase = FlowPhase.Choose, error = TIMEOUT) }
    }

    /** Runs one request with the busy flag; failures land on the screen, cancellation is silent. */
    private fun launchFlow(block: suspend () -> Unit) {
        if (_state.value.busy) return
        viewModelScope.launch {
            _state.update { it.copy(busy = true, error = null) }
            try {
                block()
            } catch (e: Throwable) {
                if (!e.isCancellation) fail(e)
            } finally {
                _state.update { it.copy(busy = false) }
            }
        }
    }

    private fun fail(e: Throwable) {
        _state.update { s ->
            when (connectFailureOf((e as? ApiException.Api)?.code)) {
                ConnectFailure.SlackConfigMissing -> s.copy(phase = FlowPhase.SlackConfig, error = "Your Slack configuration token is missing or has expired. Paste a new pair.")
                ConnectFailure.OwnBotOnly -> s.copy(phase = FlowPhase.Own, error = "One-tap connect isn't set up on this server yet. Use your own bot instead.")
                null -> s.copy(error = e.userMessage)
            }
        }
    }

    private companion object {
        const val POLL_TRIES = 200
        const val POLL_MS = 3_000L
        const val TIMEOUT = "This is taking too long. Close this and check the channel list, or try again."
    }
}
