package io.github.nigelleong0703.juno.ui.shell

import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.DropdownMenu
import androidx.compose.foundation.combinedClickable
import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.nav.Route
import io.github.nigelleong0703.juno.nav.Tab
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.openAgent
import io.github.nigelleong0703.juno.state.openChat
import io.github.nigelleong0703.juno.state.open
import io.github.nigelleong0703.juno.ui.chat.NewChatSheet
import io.github.nigelleong0703.juno.ui.components.AgentAvatar
import io.github.nigelleong0703.juno.ui.theme.AvatarSize
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/**
 * The drawer's content (iOS `Sidebar`): the account name and search, the five tabs and Plugins, "Your agents" with a
 * new-agent button, "Recents", and at the bottom a "New chat" pill with the settings button. [openTab] switches the
 * tab stack (the shell owns it); [close] shuts the drawer. Every row closes the drawer, as on iOS.
 */
@Composable
fun SidebarContent(openTab: (Tab) -> Unit, close: () -> Unit) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    var creating by remember { mutableStateOf(false) }
    val capsule = RoundedCornerShape(percent = 50)

    Column(Modifier.fillMaxSize().background(c.canvas)) {
        Row(
            Modifier.fillMaxWidth().statusBarsPadding().padding(start = 21.dp, end = 16.dp, top = 8.dp).height(44.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "Juno", color = c.fg,
                style = junoText(TextSize.Xl, FontWeight.Bold), maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            CircleIcon(JunoIcons.Search, "Search") { close(); world.open(Route.Search) }
        }

        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start = 10.dp, end = 10.dp, top = 8.dp, bottom = 16.dp),
        ) {
            for (tab in Tab.entries) {
                DrawerRow(tab.title, selected = state.tab == tab, icon = tab.icon) { openTab(tab); close() }
            }
            DrawerRow("Plugins", selected = false, icon = JunoIcons.Plugins) { close(); world.open(Route.Plugins()) }

            SectionHeader("Your agents") {
                Icon(
                    JunoIcons.Plus, "New agent", tint = c.fg,
                    modifier = Modifier.size(44.dp).clip(RoundedCornerShape(22.dp)).clickable(role = Role.Button) { close(); world.open(Route.NewAgent) }.padding(12.dp),
                )
            }
            // Tap: the agent's direct chat, else its page (iOS Sidebar `openFromSidebar`). Long press: "Profile" (iOS contextMenu).
            var profileMenu by remember { mutableStateOf<String?>(null) }
            for (agent in state.agents) {
                val current = state.tab == Tab.Chat && state.currentConversationId != null &&
                    state.currentConversationId == state.directConversation(agent.id)?.id
                Box {
                    DrawerRow(
                        agent.name.orEmpty(), selected = current, leading = { AgentAvatar(agent, AvatarSize.sm) },
                        onLongClick = { profileMenu = agent.id },
                    ) { close(); world.openAgent(agent.id) }
                    DropdownMenu(expanded = profileMenu == agent.id, onDismissRequest = { profileMenu = null }) {
                        DropdownMenuItem(text = { Text("Profile") }, onClick = { profileMenu = null; close(); world.open(Route.Agent(agent.id)) })
                    }
                }
            }

            val recents = state.recentConversations.take(20)
            if (recents.isNotEmpty()) {
                SectionHeader("Recents")
                for (conversation in recents) {
                    val current = state.tab == Tab.Chat && state.currentConversationId == conversation.id
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = 40.dp)
                            .clip(RoundedCornerShape(16.dp))
                            .background(if (current) c.muted else Color.Transparent)
                            .clickable { close(); world.openChat(conversation.id) }
                            .padding(start = 11.dp, end = 8.dp),
                        contentAlignment = Alignment.CenterStart,
                    ) {
                        Text(
                            state.title(conversation), color = c.fg, style = junoText(TextSize.Md), maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }

        Row(
            Modifier.navigationBarsPadding().padding(start = 26.dp, end = 16.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                Modifier
                    .height(52.dp)
                    .clip(capsule)
                    .background(c.primary)
                    .clickable { creating = true }
                    .padding(horizontal = 20.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(JunoIcons.Compose, contentDescription = null, tint = c.primaryFg, modifier = Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
                Text("New chat", color = c.primaryFg, style = junoText(TextSize.Lg, FontWeight.SemiBold))
            }
            Spacer(Modifier.weight(1f))
            CircleIcon(JunoIcons.Settings, "Settings") { close(); world.open(Route.Settings) }
        }
    }

    if (creating) {
        NewChatSheet(
            onDismiss = { creating = false },
            onOpenChat = { creating = false; close(); world.openChat(it) },
            onNewAgent = { creating = false; close(); world.open(Route.NewAgent) },
        )
    }
}

/** A 44 dp drawer row: an icon (or avatar) in a 24 dp column and 17 pt text; the selected row gets a `muted` fill. */
@Composable
private fun DrawerRow(
    label: String,
    selected: Boolean,
    icon: ImageVector? = null,
    leading: (@Composable () -> Unit)? = null,
    onLongClick: (() -> Unit)? = null,
    onClick: () -> Unit,
) {
    val c = JunoTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 44.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(if (selected) c.muted else Color.Transparent)
            .combinedClickable(role = Role.Button, onLongClick = onLongClick, onClick = onClick)
            .padding(start = 11.dp, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(24.dp), contentAlignment = Alignment.Center) {
            if (icon != null) Icon(icon, contentDescription = null, tint = c.fg, modifier = Modifier.size(20.dp))
            else leading?.invoke()
        }
        Spacer(Modifier.width(12.dp))
        Text(label, color = c.fg, style = junoText(TextSize.Lg), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
    }
}

/** A section title (17 pt semibold) with an optional trailing control; lines up with the row icons (iOS SidebarHeader). */
@Composable
private fun SectionHeader(title: String, trailing: (@Composable () -> Unit)? = null) {
    Row(
        Modifier.fillMaxWidth().padding(start = 21.dp, end = 3.dp, top = 22.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, color = JunoTheme.colors.fg, style = junoText(TextSize.Lg, FontWeight.SemiBold), modifier = Modifier.weight(1f))
        trailing?.invoke()
    }
}
