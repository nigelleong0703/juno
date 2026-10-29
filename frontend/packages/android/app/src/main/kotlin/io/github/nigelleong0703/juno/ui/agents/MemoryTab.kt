package io.github.nigelleong0703.juno.ui.agents

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.nigelleong0703.juno.nav.Route
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.homeFiles
import io.github.nigelleong0703.juno.state.open
import io.github.nigelleong0703.juno.state.replyStyle
import io.github.nigelleong0703.juno.ui.components.ButtonSize
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** Identity (opens the identity sheet), the shared Memory page, and the learned reply style (spec 2.16). */
@Composable
fun MemoryTab(agentId: String) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    var editing by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        TabHeader(state.agent(agentId)?.name.orEmpty())
        // iOS: a large glass "Edit" with a pencil; a bordered pill here.
        JunoButton("Edit", { editing = true }, Modifier.fillMaxWidth(), ButtonVariant.Secondary, size = ButtonSize.Hero, leadingIcon = JunoIcons.Edit, bordered = true)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            MemoryCard("Identity", "Persona & instructions", JunoIcons.Heart, Color(0xFF4A3A66), Color(0xFF8D72AD), Modifier.weight(1f)) { editing = true }
            // The shared memory page belongs to another feature: its route.
            MemoryCard("Memory", "Shared by all your agents", JunoIcons.Chat, Color(0xFF4F5A12), Color(0xFF1D2208), Modifier.weight(1f)) { world.open(Route.Memory) }
        }
        LearnedReplyStyle(agentId)
    }
    if (editing) IdentitySheet(agentId) { editing = false }
}

/** A gradient card: title and subtitle on top, icon along the bottom (22dp radius, 130dp high). */
@Composable
private fun MemoryCard(title: String, subtitle: String, icon: ImageVector, from: Color, to: Color, modifier: Modifier, onClick: () -> Unit) {
    Column(
        modifier.height(130.dp).clip(RoundedCornerShape(22.dp)).background(Brush.linearGradient(listOf(from, to))).clickable(onClick = onClick).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(title, style = junoText(TextSize.Lg, FontWeight.Bold), color = Color.White)
        Text(subtitle, style = junoText(TextSize.Xxs).copy(fontSize = 9.sp), color = Color.White.copy(alpha = 0.7f))
        Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.Bottom) {
            Icon(icon, null, tint = Color.White.copy(alpha = 0.6f), modifier = Modifier.size(18.dp))
        }
    }
}

/** Body of ALIGNMENT_SYNTHESIS.md for this agent, read-only; clamps at 10 lines or 600 chars (spec 2.16). Reloads on `homeRevision`. */
@Composable
private fun LearnedReplyStyle(agentId: String) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    var expanded by remember { mutableStateOf(false) }
    val text by produceState<String?>(null, state.homeRevision, agentId) {
        value = runCatching { world.homeFiles("ALIGNMENT_SYNTHESIS.md").firstOrNull { it.path == "ALIGNMENT_SYNTHESIS.md" } }
            .getOrNull().let { replyStyle(it?.content.orEmpty(), agentId) }
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Learned reply style", style = junoText(TextSize.Lg, FontWeight.SemiBold), color = c.fg)
        text?.let { body ->
            if (body.isEmpty()) {
                Text("${state.agent(agentId)?.name ?: "This agent"} learns how you like to be answered from your conversations over time.", style = junoText(TextSize.Base), color = c.fgMuted)
            } else {
                Text(body, style = junoText(TextSize.Base), color = c.fg, maxLines = if (expanded) Int.MAX_VALUE else 10)
                if (body.split("\n").size > 10 || body.length > 600) {
                    Text(if (expanded) "Show less" else "Show more", style = junoText(TextSize.Base, FontWeight.Medium), color = c.fgMuted, modifier = Modifier.clickable { expanded = !expanded }.padding(vertical = 4.dp))
                }
            }
        }
    }
}
