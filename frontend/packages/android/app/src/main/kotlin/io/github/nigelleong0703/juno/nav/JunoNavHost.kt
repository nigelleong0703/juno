package io.github.nigelleong0703.juno.nav

import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.dialog
import androidx.navigation.toRoute
import io.github.nigelleong0703.juno.ui.agents.AgentScreen
import io.github.nigelleong0703.juno.ui.agents.AgentsScreen
import io.github.nigelleong0703.juno.ui.agents.RunScreen
import io.github.nigelleong0703.juno.ui.agents.takeover.TakeoverScreen
import io.github.nigelleong0703.juno.ui.agents.workspace.WorkspaceScreen
import io.github.nigelleong0703.juno.ui.goals.GoalScreen
import io.github.nigelleong0703.juno.ui.goals.GoalsScreen
import io.github.nigelleong0703.juno.ui.routines.RoutinesScreen
import io.github.nigelleong0703.juno.ui.chat.ChatListScreen
import io.github.nigelleong0703.juno.ui.chat.ConversationScreen
import io.github.nigelleong0703.juno.ui.chat.NeedsYouQueueScreen
import io.github.nigelleong0703.juno.ui.chat.RequestDetailScreen
import io.github.nigelleong0703.juno.ui.chat.secure.SecureInputScreen
import io.github.nigelleong0703.juno.ui.feed.FeedPostScreen
import io.github.nigelleong0703.juno.ui.feed.FeedScreen
import io.github.nigelleong0703.juno.ui.ideas.IdeasScreen
import io.github.nigelleong0703.juno.ui.library.LibraryScreen
import io.github.nigelleong0703.juno.ui.memory.MemoryScreen
import io.github.nigelleong0703.juno.ui.search.SearchScreen
import io.github.nigelleong0703.juno.ui.screens.rules.RulesScreen
import io.github.nigelleong0703.juno.ui.screens.usage.UsageScreen
import io.github.nigelleong0703.juno.ui.screens.newagent.NewAgentScreen
import io.github.nigelleong0703.juno.ui.screens.TodoScreen
import io.github.nigelleong0703.juno.ui.settings.about.AboutMeScreen
import io.github.nigelleong0703.juno.ui.settings.models.ModelsScreen
import io.github.nigelleong0703.juno.ui.settings.profile.ProfileScreen
import io.github.nigelleong0703.juno.ui.settings.ProactiveRulesScreen
import io.github.nigelleong0703.juno.ui.settings.SettingsScreen
import io.github.nigelleong0703.juno.ui.settings.connectors.PluginsScreen
import io.github.nigelleong0703.juno.ui.components.PageScaffold
import io.github.nigelleong0703.juno.ui.discover.DiscoverScreen
import io.github.nigelleong0703.juno.ui.shell.TabRoot
import io.github.nigelleong0703.juno.ui.team.TeamScreen
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.today.TodayScreen
import io.github.nigelleong0703.juno.ui.theme.SystemBarIcons
import kotlinx.coroutines.launch

/**
 * THE ROUTE TABLE: one entry per [Route]. To port a screen, replace its `TodoScreen(...)` line with the real composable
 * (read the id from the sample's `it`); do not add parallel navigation graphs or touch other entries.
 *
 * How each route is shown comes from [Route.presentation] (transitions in [screen]): tabs switch instantly, a conversation
 * pushes, full-screen pages use shared-axis X, the agent profile zooms in, and the two sheet routes are bottom sheets.
 */
private const val PAGE_MS = 300
private const val ZOOM_MS = 250
private const val PUSH_MS = 350
private const val PARALLAX = 0.3f
private const val ZOOM_FROM = 0.9f
private val iosEase = CubicBezierEasing(0.2f, 0.8f, 0.2f, 1f)
private val pageEase = CubicBezierEasing(0.2f, 0f, 0f, 1f)
private val pushSpec = tween<IntOffset>(PUSH_MS, easing = iosEase)
private val dimSpec = tween<Float>(PUSH_MS, easing = iosEase)

private fun pushEnter(): EnterTransition = slideInHorizontally(pushSpec) { it }
private fun pushExit(): ExitTransition = slideOutHorizontally(pushSpec) { -(it * PARALLAX).toInt() } + fadeOut(dimSpec, targetAlpha = 0.9f)
private fun popEnter(): EnterTransition = slideInHorizontally(pushSpec) { -(it * PARALLAX).toInt() } + fadeIn(dimSpec, initialAlpha = 0.9f)
private fun popExit(): ExitTransition = slideOutHorizontally(pushSpec) { it }

/** Shared axis X: the page slides 30% of its width and fades in; the page it covers moves the other way and fades out. */
private val pageSpec = tween<IntOffset>(PAGE_MS, easing = pageEase)
private val pageFade = tween<Float>(PAGE_MS, easing = pageEase)
private fun pageEnter(): EnterTransition = slideInHorizontally(pageSpec) { (it * PARALLAX).toInt() } + fadeIn(pageFade)
private fun pageExit(): ExitTransition = slideOutHorizontally(pageSpec) { -(it * PARALLAX).toInt() } + fadeOut(pageFade)
private fun pagePopEnter(): EnterTransition = slideInHorizontally(pageSpec) { -(it * PARALLAX).toInt() } + fadeIn(pageFade)
private fun pagePopExit(): ExitTransition = slideOutHorizontally(pageSpec) { (it * PARALLAX).toInt() } + fadeOut(pageFade)

/** The agent profile: scales up from 0.9 and fades in; closing reverses it. */
private val zoomSpec = tween<Float>(ZOOM_MS, easing = pageEase)
private fun zoomEnter(): EnterTransition = scaleIn(zoomSpec, initialScale = ZOOM_FROM) + fadeIn(zoomSpec)
private fun zoomExit(): ExitTransition = scaleOut(zoomSpec, targetScale = ZOOM_FROM) + fadeOut(zoomSpec)

/** A page under the agent profile stays still while the profile zooms over it, and is still when the profile closes. */
private fun AnimatedContentTransitionScope<NavBackStackEntry>.coveredByProfile() = targetState.destination.hasRoute<Route.Agent>()
private fun AnimatedContentTransitionScope<NavBackStackEntry>.revealedByProfile() = initialState.destination.hasRoute<Route.Agent>()

/**
 * What a screen needs from its graph: [back] pops one level (a sheet's back closes it with its own slide), [go] opens a
 * route, [nav] is the graph's controller.
 */
private class NavEnv(
    val nav: NavHostController,
    val back: () -> Unit,
    val go: (Route) -> Unit,
)

@Composable
fun JunoNavHost(navController: NavHostController, modifier: Modifier = Modifier) {
    val env = NavEnv(navController, back = { navController.popBackStack() }, go = { navController.navigate(it) })
    NavHost(
        navController, startDestination = Route.ChatList, modifier = modifier,
        enterTransition = { pageEnter() }, exitTransition = { pageExit() },
        popEnterTransition = { pagePopEnter() }, popExitTransition = { pagePopExit() },
    ) { junoRoutes(env) }
}

/** The screens, registered once on the main graph. */
private fun NavGraphBuilder.junoRoutes(env: NavEnv) {
    // Tab roots
    screen(Route.Today, env) { TabRoot { TodayScreen() } }
    screen(Route.ChatList, env) { ChatListScreen() }
    screen(Route.Team, env) { TabRoot { TeamScreen() } }
    screen(Route.Discover, env) { TabRoot { DiscoverScreen() } }
    screen(Route.Library, env) { TabRoot { LibraryScreen() } }

    // The full Feed, Ideas and goals lists: pages pushed from Today and Team (old deep links open them too)
    screen(Route.Feed, env) { PageScaffold("Feed", back) { FeedScreen() } }
    screen(Route.Ideas, env) { PageScaffold("Ideas", back) { IdeasScreen() } }
    screen(Route.Goals, env) { PageScaffold("Goals", back) { GoalsScreen() } }

    // Conversation (push) and the pages that open over it
    screen(Route.Conversation(""), env) { r -> ConversationBleed { ConversationScreen(r.id, back) } }
    screen(Route.Agent(""), env) { r -> AgentScreen(r.id, r.tab, back) }
    screen(Route.Run(""), env) { r -> RunScreen(r.id, back) }
    screen(Route.Request(""), env) { r -> RequestDetailScreen(r.id, back) }
    screen(Route.Goal(""), env) { r -> GoalScreen(r.id, back) }
    screen(Route.FeedPost(""), env) { r -> FeedPostScreen(r.id) }
    screen(Route.Takeover(""), env) { r -> TakeoverScreen(r.agentId, r.requestId, back) }
    screen(Route.Workspace("", ""), env) { r -> WorkspaceScreen(r.conversationId, r.agentId, back) }
    screen(Route.Question(""), env) { TodoScreen("Question") }
    screen(Route.Queue, env) { NeedsYouQueueScreen(back) }
    screen(Route.SecureInput(""), env) { r -> SecureInputScreen(r.requestId, back) }
    screen(Route.NewAgent, env) { NewAgentScreen(back) }

    // Settings-type pages (full screen)
    screen(Route.Settings, env) { SettingsScreen(back) { go(it) } }
    screen(Route.Models, env) { ModelsScreen(back) }
    screen(Route.AboutYou, env) { AboutMeScreen(back) }
    screen(Route.YourDetails, env) { ProfileScreen(back) }
    screen(Route.ProactiveRules, env) { ProactiveRulesScreen(back) }
    screen(Route.Memory, env) { MemoryScreen() }
    screen(Route.Routines, env) { RoutinesScreen(onBack = back) }
    screen(Route.Rules, env) { RulesScreen(back) }
    screen(Route.Usage, env) { UsageScreen(back) }
    screen(Route.Plugins(), env) { r -> PluginsScreen(r.connectorId, back) }
    screen(Route.Skills, env) { PluginsScreen(null, back) }
    screen(Route.Channels, env) { TodoScreen("Channels") }
    screen(Route.Search, env) { SearchScreen() }
    screen(Route.Agents, env) { AgentsScreen(onBack = back) }
}

/**
 * Registers one route with the transition its [Route.presentation] asks for. A TAB switches with no motion; a PUSH
 * slides the full width; a PAGE is shared-axis X; a ZOOM is the profile's scale-and-fade; a SHEET is a dialog destination
 * that shows a Material3 bottom sheet. The sample instance is only read for its presentation.
 */
private inline fun <reified T : Route> NavGraphBuilder.screen(
    sample: T,
    env: NavEnv,
    noinline content: @Composable NavEnv.(T) -> Unit,
) {
    when (sample.presentation) {
        Presentation.TAB -> composable<T>(
            enterTransition = { EnterTransition.None }, exitTransition = { ExitTransition.None },
            popEnterTransition = { EnterTransition.None }, popExitTransition = { ExitTransition.None },
        ) { entry -> env.content(entry.toRoute()) }
        Presentation.PUSH -> composable<T>(
            enterTransition = { pushEnter() }, exitTransition = { if (coveredByProfile()) ExitTransition.None else pushExit() },
            popEnterTransition = { if (revealedByProfile()) EnterTransition.None else popEnter() }, popExitTransition = { popExit() },
        ) { entry -> env.content(entry.toRoute()) }
        Presentation.PAGE -> composable<T>(
            enterTransition = { pageEnter() }, exitTransition = { if (coveredByProfile()) ExitTransition.None else pageExit() },
            popEnterTransition = { if (revealedByProfile()) EnterTransition.None else pagePopEnter() }, popExitTransition = { pagePopExit() },
        ) { entry -> env.content(entry.toRoute()) }
        Presentation.ZOOM -> composable<T>(
            enterTransition = { zoomEnter() }, exitTransition = { zoomExit() },
            popEnterTransition = { pagePopEnter() }, popExitTransition = { zoomExit() },
        ) { entry -> env.content(entry.toRoute()) }
        Presentation.SHEET -> dialog<T>(dialogProperties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) { entry ->
            BottomSheet(onRemoved = { env.back() }) { close ->
                NavEnv(env.nav, back = close, go = env.go).content(entry.toRoute())
            }
        }
    }
}

/**
 * A Material3 bottom sheet for a SHEET route. [close] animates it away, then pops the route; a drag or scrim tap pops it
 * directly. The pop happens once either way.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BottomSheet(onRemoved: () -> Unit, content: @Composable (close: () -> Unit) -> Unit) {
    val c = JunoTheme.colors
    val view = LocalView.current
    // The sheet is its own window: its status-bar icons follow the app theme, like the activity's.
    SystemBarIcons((view.parent as? DialogWindowProvider)?.window, c.isDark)
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    var removed by remember { mutableStateOf(false) }
    val remove: () -> Unit = { if (!removed) { removed = true; onRemoved() } }
    val close: () -> Unit = { scope.launch { state.hide() }.invokeOnCompletion { remove() } }
    ModalBottomSheet(onDismissRequest = remove, sheetState = state, containerColor = c.canvas) { content(close) }
}

/**
 * A conversation draws under the status bar: the scaffold pads the page by the status bar, so the page is pulled back up
 * by that inset (ChatList does the same), and its header pads itself.
 */
@Composable
private fun ConversationBleed(content: @Composable () -> Unit) {
    val density = LocalDensity.current
    val top = WindowInsets.safeDrawing.getTop(density)
    // The status bar's height, for the screen's own top controls: the window insets are already consumed by the time
    // they reach the page, so a `statusBarsPadding()` inside it is zero.
    // The scaffold pads the page by the side insets too (a navigation bar or cutout on the left in landscape): the
    // conversation's background runs under them, and its own content is inset by them (see ConversationScreen).
    val left = WindowInsets.safeDrawing.getLeft(density, LayoutDirection.Ltr)
    val right = WindowInsets.safeDrawing.getRight(density, LayoutDirection.Ltr)
    CompositionLocalProvider(LocalStatusBarHeight provides with(density) { top.toDp() }) {
        Box(Modifier.fillMaxSize().bleed(top, left, right)) { content() }
    }
}

/** The status bar's height where a screen draws under it (set by [ConversationBleed]). */
val LocalStatusBarHeight = compositionLocalOf { 0.dp }

/** Draws [top] px above and [left]/[right] px beside the page's bounds, under the insets the scaffold took. */
private fun Modifier.bleed(top: Int, left: Int, right: Int) = layout { measurable, constraints ->
    val width = constraints.maxWidth + left + right
    val placeable = measurable.measure(Constraints.fixed(width, constraints.maxHeight + top))
    layout(constraints.maxWidth, constraints.maxHeight) { placeable.place(-left, -top) }
}
