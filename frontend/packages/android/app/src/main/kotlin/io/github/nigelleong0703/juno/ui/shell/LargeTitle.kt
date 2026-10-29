package io.github.nigelleong0703.juno.ui.shell

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.setSidebarOpen
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/**
 * The top of a top-level tab (iOS `TabHeader` + the Chats home): circle buttons, ☰ at the leading end and the page's own
 * actions at the trailing end. No app bar; the large title comes from the content below.
 */
@Composable
fun TabTopRow(trailing: @Composable RowScope.() -> Unit) {
    val world = LocalWorld.current
    Row(
        Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 8.dp).height(44.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        CircleIcon(JunoIcons.Menu, "Menu") { world.setSidebarOpen(true) }
        Box(Modifier.weight(1f))
        trailing()
    }
}

/** The page's name in the iOS large-title style (`TabHeading`: 2xl bold, 16 dp inset). */
@Composable
fun LargeTitle(title: String) {
    Text(
        title, color = JunoTheme.colors.fg, style = junoText(TextSize.Xxl, FontWeight.Bold), maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
    )
}

/**
 * A top-level tab (Today, Team, Discover, Library): the shell's top row with the agent scope button, then the screen. The
 * screen draws its own large heading (the same style as [LargeTitle]), so the shell adds none.
 */
@Composable
fun TabRoot(content: @Composable () -> Unit) {
    Column(Modifier.fillMaxSize().background(JunoTheme.colors.canvas)) {
        TabTopRow { AgentScopeButton() }
        Box(Modifier.weight(1f).fillMaxWidth()) { content() }
    }
}
