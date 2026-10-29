package io.github.nigelleong0703.juno.nav

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.ui.graphics.vector.ImageVector

/**
 * The five bottom tabs, in the owner-approved order (2026-10-26, iOS JunoTabBarController.tabs): Today · Chat · Team ·
 * Discover · Library. They replace Chat · Feed · Ideas · Goals · Library: Feed and Ideas now live under Today, Goals
 * under Team. [key] is the same string iOS keeps in `world.tab`. [icon] is the tab's glyph.
 */
enum class Tab(val key: String, val title: String, val icon: ImageVector, val root: Route) {
    Today("today", "Today", JunoIcons.Sun, Route.Today),
    Chat("chat", "Chat", JunoIcons.Chat, Route.ChatList),
    Team("team", "Team", JunoIcons.Users, Route.Team),
    Discover("discover", "Discover", JunoIcons.Grid, Route.Discover),
    Library("library", "Library", JunoIcons.Library, Route.Library),
}
