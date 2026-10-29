package io.github.nigelleong0703.juno.nav

import kotlinx.serialization.Serializable

/**
 * Every top-level screen of the app as a type-safe navigation-compose route (the iOS `Route` / `GlobalPage` /
 * `SheetRoute` / `SettingsLink` destinations, flattened). A feature agent adds its screen composable to
 * [JunoNavHost]'s `composable<...>` entry; it never needs to touch this table unless iOS has a screen missing here.
 *
 * Objects are parameterless screens, classes carry the id of the thing they show.
 */
/**
 * How a route is shown (the Muse for Android presentation, see packages/android/README.md):
 * - TAB: a tab root, switched with no motion.
 * - PUSH: a conversation; slides in from the right, as before.
 * - PAGE: a full-screen page (settings-type pages, lists, takeover): shared-axis X, slides ~30% and fades, 300 ms.
 * - ZOOM: the agent profile: scales from 0.9 and fades in, 250 ms.
 * - SHEET: a Material3 bottom sheet over the page behind it (new chat, secure input).
 */
enum class Presentation { TAB, PUSH, PAGE, ZOOM, SHEET }

@Serializable sealed interface Route {
    /** The one place that says how each route is shown (see [Presentation]). */
    val presentation: Presentation
        get() = when (this) {
            ChatList, Today, Team, Discover, Library -> Presentation.TAB
            is Conversation -> Presentation.PUSH
            is Agent -> Presentation.ZOOM
            NewAgent, is SecureInput -> Presentation.SHEET
            Agents, is Run, is Request, is Goal, Feed, Ideas, Goals, is FeedPost, is Plugins, Skills, Routines, Rules, Memory, Usage, Channels,
            Search, Settings, Models, AboutYou, YourDetails, ProactiveRules, is Workspace, is Takeover, Queue, is Question -> Presentation.PAGE
        }

    // --- Tab roots (Tab.root) ---
    @Serializable data object ChatList : Route
    @Serializable data object Today : Route
    @Serializable data object Team : Route
    @Serializable data object Discover : Route
    @Serializable data object Library : Route

    // --- Pushed pages ---
    /** A chat; iOS `Route.chat`. */
    @Serializable data class Conversation(val id: String) : Route
    @Serializable data object Agents : Route
    @Serializable data class Agent(val id: String, val tab: String? = null) : Route
    @Serializable data class Run(val id: String) : Route
    @Serializable data class Request(val id: String) : Route
    @Serializable data class Goal(val id: String) : Route
    /** The full Feed, Ideas and goals list: no longer tabs (owner-approved 2026-10-26), pushed from Today and Team. */
    @Serializable data object Feed : Route
    @Serializable data object Ideas : Route
    @Serializable data object Goals : Route
    @Serializable data class FeedPost(val id: String) : Route
    /** Plugins (connectors + skills); an optional connector to open straight away. */
    @Serializable data class Plugins(val connectorId: String? = null) : Route

    // --- GlobalPage (iOS: Routines, Rules, Skills, Memory, Library, Usage) ---
    @Serializable data object Routines : Route
    @Serializable data object Rules : Route
    @Serializable data object Skills : Route
    @Serializable data object Memory : Route
    @Serializable data object Usage : Route

    // --- Other top-level features ---
    @Serializable data object Channels : Route
    @Serializable data object Search : Route
    @Serializable data object Settings : Route
    @Serializable data object Models : Route
    @Serializable data object AboutYou : Route
    @Serializable data object YourDetails : Route
    @Serializable data object ProactiveRules : Route
    @Serializable data object NewAgent : Route
    @Serializable data class Workspace(val conversationId: String, val agentId: String) : Route
    /** The take-over (remote control) screen; the request it opens for, if any. */
    @Serializable data class Takeover(val agentId: String, val requestId: String? = null) : Route
    @Serializable data object Queue : Route
    @Serializable data class Question(val requestId: String) : Route
    @Serializable data class SecureInput(val requestId: String) : Route
}
