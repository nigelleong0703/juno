package io.github.nigelleong0703.juno.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBars
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.height
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import io.github.nigelleong0703.juno.ui.components.agentTint
import io.github.nigelleong0703.juno.contract.Item
import io.github.nigelleong0703.juno.nav.Route
import io.github.nigelleong0703.juno.nav.LocalStatusBarHeight
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.closeChat
import io.github.nigelleong0703.juno.state.discard
import io.github.nigelleong0703.juno.state.enterChat
import io.github.nigelleong0703.juno.state.loadOlder
import io.github.nigelleong0703.juno.state.open
import io.github.nigelleong0703.juno.state.reattach
import io.github.nigelleong0703.juno.state.reportTyping
import io.github.nigelleong0703.juno.state.retry
import io.github.nigelleong0703.juno.state.send
import io.github.nigelleong0703.juno.state.setDraft
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.delay
import java.time.Instant

/**
 * A chat (spec 2.2): header, bottom-anchored transcript, composer and jump-to-latest. Navigation out of the chat
 * (agent card, Feed post, Routines, Computer) defaults to `world.open(Route...)`, so the shell handles it; pass a lambda to
 * override. [onBack] pops the screen.
 */
@Composable
fun ConversationScreen(
    conversationId: String,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    onOpenAgent: ((agentId: String) -> Unit)? = null,
    onOpenFeedPost: ((postId: String) -> Unit)? = null,
    onOpenRoutines: (() -> Unit)? = null,
    onOpenWorkspace: ((conversationId: String, agentId: String) -> Unit)? = null,
) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val c = JunoTheme.colors
    val id = conversationId
    val conversation = state.conversation(id)

    val composer = remember(id) { ComposerController(id, world, context, scope, world.state.value.drafts[id].orEmpty()) }
    val reactions = remember { Reactions(context) }
    DisposableEffect(id) {
        world.enterChat(id)
        onDispose {
            // Leaving keeps the unsent text for the next visit; presence goes quiet.
            world.setDraft(id, composer.model.text)
            composer.dispose()
            if (world.state.value.currentConversationId == id) world.closeChat()
            world.reportTyping(false, id)
        }
    }

    // Typing presence: direct chats only, at most once a second while typing, a trailing false when the draft empties.
    val gate = remember(id) { TypingGate() }
    val direct = conversation?.kind == "direct" && conversation.channel == null
    LaunchedEffect(composer.model.text, direct) {
        if (direct) gate.onDraft(composer.model.text, System.currentTimeMillis())?.let { world.reportTyping(it, id) }
    }

    // "Reconnecting…" only once the stream has been down past a short grace.
    var pastGrace by remember { mutableStateOf(false) }
    LaunchedEffect(state.streamLive) { pastGrace = false; if (!state.streamLive) { delay(4000); pastGrace = true } }

    // The working pill appears 8 s into a run: re-evaluate the transcript while a run is active.
    var now by remember { mutableStateOf(Instant.now()) }
    val active = state.activeRunsIn(id).isNotEmpty()
    LaunchedEffect(active) { while (active) { delay(1000); now = Instant.now() } }
    val entries = remember(state.items[id], state.previews[id], state.history[id], state.runs, state.childRuns, state.requests, state.displayIds, state.itemsLoading, now) {
        ChatFeed.entries(state, id, now)
    }

    var stepsRun by remember { mutableStateOf<String?>(null) }
    val isGroup = conversation?.kind == "room"
    // iOS `world.accent(for:)`: a one-agent chat takes that agent's character tint.
    val accent = conversation?.let { c -> if (c.kind != "room" && c.agentIds?.size == 1) agentTint(state.agent(c.agentIds.first())) else null }
    val actions = remember(id, isGroup, accent) { ChatActions(
        chatId = id, isGroup = isGroup, reactions = reactions.map,
        onReply = { composer.replyTo = it },
        onSend = { world.send(it, id) },
        onOpenAgent = { agent -> onOpenAgent?.invoke(agent) ?: world.open(Route.Agent(agent)) },
        onOpenSteps = { stepsRun = it },
        onReact = { item, emoji -> reactions.toggle(item.id, emoji) },
        onRetry = { world.retry(it.id, id) },
        onDiscard = { world.discard(it.id, id) },
        onOpenFeedPost = { post -> onOpenFeedPost?.invoke(post) ?: world.open(Route.FeedPost(post)) },
        onOpenRoutines = { onOpenRoutines?.invoke() ?: world.open(Route.Routines) },
        accent = accent,
        onSystemAction = { item ->
            when (item.action?.command) {
                "run.retry" -> world.state.value.run(item.runId)?.let { retryRun(world, world.state.value, it) { stepsRun = it.id } }
                "computer.open" -> (item.agentId ?: world.state.value.conversation(id)?.agentIds?.firstOrNull())?.let { agent ->
                    onOpenWorkspace?.invoke(id, agent) ?: world.open(Route.Workspace(id, agent))
                }
            }
        },
    ) }

    // The background runs under the side insets (ConversationBleed); the content is inset from them.
    // iOS Conversation: the accent washes down from the top, 260pt, fading to clear — drawn here so it also runs under
    // the side insets with the canvas.
    Column(modifier.fillMaxSize().background(c.canvas)
        .drawBehind {
            accent?.let {
                val h = 260.dp.toPx()
                drawRect(Brush.verticalGradient(listOf(it.copy(alpha = 0.16f), Color.Transparent), endY = h), size = Size(size.width, h))
            }
        }
        .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal)).consumeWindowInsets(WindowInsets.systemBars).imePadding()) {
        if (conversation == null) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text("This chat is no longer available.", color = c.fgMuted, style = junoText(TextSize.Base)) }
            return@Column
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            // The header floats over the transcript (no bar): the list starts below it and scrolls under it.
            var headerPx by remember { mutableStateOf(0) }
            val headerTop = with(LocalDensity.current) { headerPx.toDp() }
            TranscriptList(
                entries, state, state.history[id], isMine = { it.item?.type == "user_message" && it.item.authorId == state.selfId },
                a = actions, onLoadOlder = { world.loadOlder(id) }, onReattach = { world.reattach(id) },
                contentPadding = PaddingValues(top = headerTop + 8.dp, bottom = 8.dp),
                // Text fades out under the floating header; the bottom fade is short, so the last message (which sits
                // inside the 8 dp content padding) stays fully legible above the composer, as Muse's does.
                modifier = Modifier.edgeFade(top = headerTop, topFade = 40.dp, bottom = 8.dp),
            )
            val agentWorking = conversation.agentIds.orEmpty().any { state.agent(it)?.status == "working" }
            if (state.chatLoaded(id) && entries.isEmpty() && !active && !agentWorking) EmptyChat(conversation.kind == "room", state.agent(conversation.agentIds?.firstOrNull())?.name)
            ConversationHeader(
                conversation, state, reconnecting = pastGrace, onBack = onBack, onOpenAgent = actions.onOpenAgent,
                onOpenComputer = conversation.agentIds?.firstOrNull()?.let { agent -> { onOpenWorkspace?.invoke(id, agent) ?: world.open(Route.Workspace(id, agent)) } },
                modifier = Modifier.align(Alignment.TopCenter).padding(top = LocalStatusBarHeight.current).onSizeChanged { headerPx = it.height },
            )
        }
        val platform = conversation.channel?.kind
        if (platform != null) {
            Text(
                "This chat happens in ${platformName(platform)}. Reply there.", color = c.fgMuted, style = junoText(TextSize.Sm), textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 28.dp, vertical = 16.dp),
            )
        } else {
            val room = if (conversation.kind == "room") conversation.agentIds.orEmpty().mapNotNull { state.agent(it) } else emptyList()
            Composer(composer, room, replySender = { if (it.type == "user_message") "You" else state.agent(it.agentId)?.name ?: "Agent" }, modifier = Modifier.padding(bottom = 8.dp))
        }
    }

    stepsRun?.let { RunStepsSheet(it) { stepsRun = null } }
}

@Composable
private fun EmptyChat(isRoom: Boolean, agentName: String?) {
    Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
        Text(
            if (isRoom) "Mention an agent to start the conversation." else "Say hello — ${agentName ?: "your agent"} is ready when you are.",
            color = JunoTheme.colors.fgMuted, style = junoText(TextSize.Base), textAlign = TextAlign.Center,
        )
    }
}
