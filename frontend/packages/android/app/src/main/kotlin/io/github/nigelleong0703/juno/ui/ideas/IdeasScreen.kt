package io.github.nigelleong0703.juno.ui.ideas

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Agent
import io.github.nigelleong0703.juno.contract.Idea
import io.github.nigelleong0703.juno.contract.Inspiration
import io.github.nigelleong0703.juno.nav.Route
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.World
import io.github.nigelleong0703.juno.state.WorldState
import io.github.nigelleong0703.juno.state.acceptIdea
import io.github.nigelleong0703.juno.state.dismissInspiration
import io.github.nigelleong0703.juno.state.ideaFeedback
import io.github.nigelleong0703.juno.state.undoProactiveRule
import io.github.nigelleong0703.juno.state.open
import io.github.nigelleong0703.juno.state.openAgent
import io.github.nigelleong0703.juno.state.openChat
import io.github.nigelleong0703.juno.state.visibleInspiration
import io.github.nigelleong0703.juno.ui.components.AgentAvatar
import io.github.nigelleong0703.juno.ui.components.BrandIcon
import io.github.nigelleong0703.juno.ui.components.CardAction
import io.github.nigelleong0703.juno.ui.components.CardLabel
import io.github.nigelleong0703.juno.ui.components.EmptyState
import io.github.nigelleong0703.juno.ui.components.ShowMore
import io.github.nigelleong0703.juno.ui.components.SuggestionCard
import io.github.nigelleong0703.juno.ui.theme.AvatarSize
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

private const val SECTION_STEP = 5

/** The three sections, in the order the page shows them. */
private enum class Section(val title: String) { Ready("Ready for you"), Ideas("Ideas"), Suggestions("Suggestions") }

/**
 * The Ideas page (iOS `IdeasPage`), pushed from Today: "Ready for you" (a draft is waiting), "Ideas" from the daily job,
 * and "Suggestions" from Today (not filtered by agent). Five per section, then "Show more". "Do it" starts an agent chat;
 * "Not now" and long-press remove an item.
 */
@Composable
fun IdeasScreen() {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    val scoped = state.ideas.filter { state.scope == null || it.agentId == state.scope }
    val ready = scoped.filter { it.prepared?.kind == "draft" && it.prepared?.ref != null }
    val others = scoped.filter { idea -> ready.none { it.id == idea.id } }
    val cards = state.visibleInspiration
    var limits by remember { mutableStateOf(emptyMap<Section, Int>()) }
    var draft by remember { mutableStateOf<Idea?>(null) }
    LaunchedEffect(state.scope) { limits = emptyMap() }
    fun limitOf(section: Section) = limits[section] ?: SECTION_STEP
    fun more(section: Section) { limits = limits + (section to limitOf(section) + SECTION_STEP) }

    val snackbar = remember { SnackbarHostState() }
    // "Not now" / "Less like this": what was decided, with Undo when it made a rule (Undo deletes the rule).
    LaunchedEffect(state.proactiveToast?.id) {
        val toast = state.proactiveToast ?: return@LaunchedEffect
        val result = snackbar.showSnackbar(toast.text, actionLabel = if (toast.ruleId != null) "Undo" else null, duration = SnackbarDuration.Indefinite)
        if (result == SnackbarResult.ActionPerformed) world.undoProactiveRule(toast)
    }
    LaunchedEffect(state.proactiveToast) { if (state.proactiveToast == null) snackbar.currentSnackbarData?.dismiss() }

    Box(Modifier.fillMaxSize()) {
    if (scoped.isEmpty() && cards.isEmpty()) {
        Column(
            Modifier.fillMaxSize().background(c.canvas).padding(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            EmptyState(JunoIcons.Ideas, "No ideas yet", "Ideas show up here each morning, based on your goals and conversations.")
        }
    } else {
        LazyColumn(
            Modifier.fillMaxSize().background(c.canvas),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            section(Section.Ready, ready, limitOf(Section.Ready), { more(Section.Ready) }, { it.id }) { idea ->
                IdeaCard(idea, state.agent(idea.agentId), subtitle(state, idea, "Draft ready"), hasDraft = true, world = world) { draft = idea }
            }
            section(Section.Ideas, others, limitOf(Section.Ideas), { more(Section.Ideas) }, { it.id }) { idea ->
                IdeaCard(idea, state.agent(idea.agentId), subtitle(state, idea, idea.why), hasDraft = false, world = world) {}
            }
            section(Section.Suggestions, cards, limitOf(Section.Suggestions), { more(Section.Suggestions) }, { it.id }) { card ->
                SuggestionRowCard(card, state.agent(card.agentId), world)
            }
        }
    }
    SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter)) { data ->
        Snackbar(data, containerColor = c.card, contentColor = c.fg, actionContentColor = c.fg)
    }
    }

    draft?.let { idea -> IdeaDraftSheet(idea) { draft = null } }
}

private fun subtitle(state: WorldState, idea: Idea, detail: String?): String =
    listOfNotNull(state.agent(idea.agentId)?.name, detail).filter { it.isNotEmpty() }.joinToString(" · ")

/** A section: its label, up to [limit] rows, then "Show more". */
private fun <T> LazyListScope.section(
    id: Section,
    items: List<T>,
    limit: Int,
    onMore: () -> Unit,
    key: (T) -> Any,
    row: @Composable (T) -> Unit,
) {
    if (items.isEmpty()) return
    item(key = "header-${id.name}") {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(id.title, style = junoText(TextSize.Sm, FontWeight.SemiBold), color = JunoTheme.colors.fgMuted, modifier = Modifier.padding(start = 4.dp))
        }
    }
    items(items.take(limit), key = key, contentType = { "idea" }) { row(it) }
    item(key = "more-${id.name}") { ShowMore(shown = minOf(limit, items.size), total = items.size, onMore = onMore) }
}

@Composable
private fun IdeaCard(idea: Idea, agent: Agent?, subtitle: String, hasDraft: Boolean, world: World, onDraft: () -> Unit) {
    val text = idea.text ?: idea.prompt.orEmpty()
    val buttons = buildList {
        if (hasDraft) add(CardAction(CardLabel.Draft.text(text), CardAction.Style.Link, onDraft))
        add(CardAction(CardLabel.NotNow.text(text), CardAction.Style.Ghost) { world.ideaFeedback(idea.id, "not_now") })
        add(CardAction(CardLabel.DoIt.text(text), CardAction.Style.Primary) { world.acceptIdea(idea) })
    }
    // Written out so there is no guessing what each choice does.
    val less = listOf(
        CardAction("Fewer about this topic") { world.ideaFeedback(idea.id, "less", "topic") },
        CardAction("Fewer ideas like this") { world.ideaFeedback(idea.id, "less", "type") },
        CardAction("Never suggest this") { world.ideaFeedback(idea.id, "never", "topic") },
    )
    SuggestionCard(
        title = text,
        subtitle = subtitle,
        leading = { AgentAvatar(agent, size = AvatarSize.md, animated = false, tile = true) },
        buttons = buttons,
        onNotInterested = { world.ideaFeedback(idea.id, "not_now") },
        lessLabel = "Less like this",
        lessItems = less,
        dismissLabel = "Not now",
    )
}

/** A suggestion from Today: the button starts a chat with its agent, or opens the page its unlock needs. */
@Composable
private fun SuggestionRowCard(card: Inspiration, agent: Agent?, world: World) {
    val action = card.action
    val unlock = action?.type == "unlock"
    val label = if (unlock) card.prompt?.takeIf { it.isNotEmpty() } ?: "Set up"
    else CardLabel.Start.text("${card.title.orEmpty()} ${card.prompt.orEmpty()}")
    val subtitle = if (unlock) card.reason.orEmpty()
    else listOfNotNull(agent?.name, card.reason).filter { it.isNotEmpty() }.joinToString(" · ")
    SuggestionCard(
        title = card.title.orEmpty(),
        subtitle = subtitle,
        leading = {
            if (action?.target == "connector") {
                // iOS UnlockTile: the connector's brand logo, the puzzle piece when it has none.
                BrandIcon(action.connectorId, JunoIcons.Plugins, AvatarSize.md)
            } else if (unlock || agent == null) {
                SuggestionTile(JunoIcons.Ideas)
            } else {
                AgentAvatar(agent, size = AvatarSize.md, animated = false, tile = true)
            }
        },
        buttons = listOf(CardAction(label) { perform(world, card) }),
        onNotInterested = { world.dismissInspiration(card.id) },
    )
}

/** What a suggestion does: a chat with its agent (prefilled with the prompt), or the page its unlock needs. */
private fun perform(world: World, card: Inspiration) {
    val action = card.action ?: return
    if (action.type != "unlock") {
        val agentId = action.agentId ?: card.agentId.orEmpty()
        val chat = world.state.value.directConversation(agentId)
        if (chat != null) world.openChat(chat.id, draft = action.text) else world.openAgent(agentId)
        return
    }
    when (action.target) {
        "connector" -> world.open(Route.Plugins(action.connectorId))
        "profile" -> world.open(Route.Settings)
        else -> world.open(Route.Agent(action.agentId ?: card.agentId.orEmpty(), tab = "computer"))
    }
}

@Composable
private fun SuggestionTile(icon: ImageVector) {
    Box(Modifier.size(AvatarSize.md).clip(RoundedCornerShape(Radius.sm)).background(JunoTheme.colors.tile), contentAlignment = Alignment.Center) {
        Icon(icon, contentDescription = null, tint = JunoTheme.colors.fgMuted, modifier = Modifier.size(18.dp))
    }
}
