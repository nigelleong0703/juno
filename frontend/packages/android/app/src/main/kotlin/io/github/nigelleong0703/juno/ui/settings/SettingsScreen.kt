package io.github.nigelleong0703.juno.ui.settings

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.vector.ImageVector
import io.github.nigelleong0703.juno.nav.Route
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.doingLine
import io.github.nigelleong0703.juno.ui.components.AgentAvatar
import io.github.nigelleong0703.juno.ui.components.ConfirmDialog
import io.github.nigelleong0703.juno.ui.components.GroupedPage
import io.github.nigelleong0703.juno.ui.components.GroupedRow
import io.github.nigelleong0703.juno.ui.components.GroupedSection
import io.github.nigelleong0703.juno.ui.components.PageLeading
import io.github.nigelleong0703.juno.ui.components.RowMarker
import io.github.nigelleong0703.juno.ui.shell.AgentRow
import io.github.nigelleong0703.juno.ui.theme.AvatarSize

/** A row of the Workspace section: the global pages iOS lists (GlobalPage minus Library and Skills, which the tabs own). */
private data class WorkspacePage(val title: String, val icon: ImageVector, val route: Route)

private val workspacePages = listOf(
    WorkspacePage("Routines", JunoIcons.Refresh, Route.Routines),
    WorkspacePage("Rules", JunoIcons.Shield, Route.Rules),
    WorkspacePage("Memory", JunoIcons.Brain, Route.Memory),
    WorkspacePage("Usage", JunoIcons.Usage, Route.Usage),
)

/**
 * The settings page (iOS RootView.swift MorePage): Agents, Account, About you / Your details, "Agents run on" (Models),
 * then the Workspace pages. [onOpen] pushes a route onto the current stack. Apple Watch is not on Android.
 */
@Composable
fun SettingsScreen(onBack: () -> Unit, onOpen: (Route) -> Unit) {
    val world = LocalWorld.current
    val session by world.session.collectAsState()
    val state by world.state.collectAsState()
    var confirmSignOut by remember { mutableStateOf(false) }
    GroupedPage("Settings", onBack) {
        GroupedSection(header = "Agents") {
            if (state.agents.isEmpty()) SettingsEmpty("No agents yet.")
            state.agents.forEach { a ->
                AgentRow(
                    avatar = { AgentAvatar(a, AvatarSize.md) }, title = a.name.orEmpty(), subtitle = state.doingLine(a),
                    onClick = { onOpen(Route.Agent(a.id)) },
                )
            }
        }
        session?.let { s ->
            GroupedSection(header = "Account") {
                GroupedRow(s.name, value = s.email)
                GroupedRow("Server", value = s.server)
                GroupedRow("Sign out", destructive = true, onClick = { confirmSignOut = true })
            }
        }
        GroupedSection {
            GroupedRow("About you", icon = JunoIcons.ContactPage, marker = RowMarker.Chevron, onClick = { onOpen(Route.AboutYou) })
            GroupedRow("Your details", icon = JunoIcons.AccountBox, marker = RowMarker.Chevron, onClick = { onOpen(Route.YourDetails) })
            GroupedRow("What's worth interrupting me for", icon = JunoIcons.Bell, marker = RowMarker.Chevron, onClick = { onOpen(Route.ProactiveRules) })
        }
        GroupedSection(header = "Agents run on") {
            GroupedRow("Models", icon = JunoIcons.Cpu, marker = RowMarker.Chevron, onClick = { onOpen(Route.Models) })
        }
        GroupedSection(header = "Workspace") {
            workspacePages.forEach { page ->
                GroupedRow(page.title, icon = page.icon, marker = RowMarker.Chevron, onClick = { onOpen(page.route) })
            }
        }
    }
    if (confirmSignOut) {
        ConfirmDialog(
            title = "Sign out?", body = null, confirm = "Sign out",
            onConfirm = { confirmSignOut = false; world.signOut() },
            onDismiss = { confirmSignOut = false },
        )
    }
}
