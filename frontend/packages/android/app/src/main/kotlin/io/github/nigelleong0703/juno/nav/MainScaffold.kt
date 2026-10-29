package io.github.nigelleong0703.juno.nav

import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.padding
import kotlinx.coroutines.CancellationException
import androidx.navigation.FloatingWindow
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavHostController
import androidx.navigation.compose.rememberNavController
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.consumePendingRoute
import io.github.nigelleong0703.juno.state.dismissSyncError
import io.github.nigelleong0703.juno.state.selectTab
import io.github.nigelleong0703.juno.state.setSidebarOpen
import io.github.nigelleong0703.juno.ui.shell.Drawer
import io.github.nigelleong0703.juno.ui.shell.SidebarContent
import io.github.nigelleong0703.juno.ui.shell.TabBar
import io.github.nigelleong0703.juno.ui.theme.JunoTheme

/**
 * The signed-in shell (iOS RootView + DrawerController + JunoTabBarController): the ☰ drawer slides the whole app
 * right, five tabs each with its own back stack, and the tab bar shown only on the tab roots.
 * [io.github.nigelleong0703.juno.state.WorldState.pendingRoute] is how non-UI code navigates.
 */
@Composable
fun MainScaffold() {
    MainShell()
}

@Composable
private fun MainShell() {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val nav = rememberNavController()
    // The page the user is on: sheets are dialog destinations over it, so the page is the last entry that is not one.
    val backStack by nav.currentBackStack.collectAsState()
    val page = backStack.lastOrNull { it.destination !is FloatingWindow }?.destination
    val inTakeover = page?.hasRoute<Route.Takeover>() == true
    val onTabRoot = page != null && Tab.entries.any { page.hasRoute(it.root::class) }
    val inChat = page?.hasRoute<Route.Conversation>() == true
    val edge = with(LocalDensity.current) { 44.dp.toPx() }

    LaunchedEffect(state.pendingRoute) {
        val route = state.pendingRoute ?: return@LaunchedEffect
        // A bottom sheet stays over the page only for another sheet; any other destination closes it first.
        if (route.presentation != Presentation.SHEET) nav.closeSheets()
        // A tab's root is a tab switch, never a page pushed onto the current tab (the tab bar would stay on the old
        // tab and its page would be buried).
        val tab = Tab.entries.firstOrNull { it.root == route }
        if (tab != null) {
            world.selectTab(tab)
            nav.switchTab(tab)
        } else {
            // A chat always lives under the Chat tab, whichever tab asked for it.
            if (route is Route.Conversation) nav.switchTab(Tab.Chat)
            // The Feed already on top takes a focus request in place (FeedScreen reads state.feedFocus); a second Feed page is never pushed.
            val feedOnTop = route == Route.Feed && page?.hasRoute<Route.Feed>() == true
            if (!feedOnTop) nav.navigate(route)
        }
        world.consumePendingRoute()
    }

    val openTab: (Tab) -> Unit = { tab -> world.selectTab(tab); nav.switchTab(tab) }

    // Back closes an open drawer before it leaves the screen. Predictive back (Android 14+) previews the close; a
    // cancelled gesture keeps the drawer open.
    PredictiveBackHandler(enabled = state.sidebarOpen) { progress ->
        try {
            progress.collect { }
            world.setSidebarOpen(false)
        } catch (_: CancellationException) {
            // The user backed out of the gesture.
        }
    }

    Drawer(
        open = state.sidebarOpen,
        onOpenChange = { world.setSidebarOpen(it) },
        // iOS: on the Chat tab a right swipe means "back" in a chat, so the drawer opens there only from the leading
        // edge of the chat list. Other tabs open from anywhere; takeover (remote control) never opens it.
        canOpenFrom = { x -> !inTakeover && (state.tab != Tab.Chat || (!inChat && x < edge)) },
        sidebar = { SidebarContent(openTab = openTab, close = { world.setSidebarOpen(false) }) },
    ) {
        Scaffold(
            containerColor = if (inTakeover) Color.Black else JunoTheme.colors.canvas,
            bottomBar = {
                if (onTabRoot && !inTakeover) {
                    TabBar(
                        selected = state.tab,
                        // Needs you rides on Today, the first tab (owner-approved 2026-10-26).
                        badgeFor = { if (it == Tab.Today) state.needsYou.size else 0 },
                        onSelect = openTab,
                    )
                }
            },
        ) { padding -> JunoNavHost(nav, Modifier.padding(padding)) }
    }

    state.syncError?.let { message ->
        AlertDialog(
            onDismissRequest = { world.dismissSyncError() }, title = { Text("Couldn't reach the server") }, text = { Text(message) },
            confirmButton = { TextButton({ world.dismissSyncError() }) { Text("OK") } },
        )
    }
}

private fun NavHostController.topIsSheet() = currentBackStack.value.lastOrNull()?.destination is FloatingWindow

private fun NavHostController.closeSheets() {
    while (topIsSheet()) popBackStack()
}

/** Switches to a tab, keeping each tab's own back stack. */
private fun NavHostController.switchTab(tab: Tab) = navigate(tab.root) {
    popUpTo(graph.startDestinationId) { saveState = true }
    launchSingleTop = true
    restoreState = true
}
