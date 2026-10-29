package io.github.nigelleong0703.juno.ui.agents.permissions

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.clickable
import io.github.nigelleong0703.juno.ui.components.Hairline
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Rule
import io.github.nigelleong0703.juno.core.parseIso
import io.github.nigelleong0703.juno.state.DecisionWords
import io.github.nigelleong0703.juno.state.Fmt
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.agentsData
import io.github.nigelleong0703.juno.state.delegationsOf
import io.github.nigelleong0703.juno.ui.agents.SectionCard
import io.github.nigelleong0703.juno.ui.agents.TabHeader
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import java.time.Instant

fun categoryIcon(category: String?): ImageVector = when (category) {
    "spending" -> JunoIcons.CreditCard
    "speaking" -> JunoIcons.Chat
    "public" -> JunoIcons.Megaphone
    "committing" -> JunoIcons.CalendarCheck
    "irreversible" -> JunoIcons.Trash
    "sensitive" -> JunoIcons.Lock
    "sharing" -> JunoIcons.Share
    "setup" -> JunoIcons.Settings
    "choice" -> JunoIcons.List
    else -> JunoIcons.Pointer
}

/** One category per row: "Ask me", or its delegations with their limits in words; tap one to edit or revoke it (spec 2.18). */
@Composable
fun AuthorityTable(agentId: String) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val data by world.agentsData.collectAsState()
    val c = JunoTheme.colors
    var editing by remember { mutableStateOf<Rule?>(null) }
    var expanded by remember { mutableStateOf(setOf<String>()) }
    val rules = data.delegationsOf(agentId)
    val chatName = { id: String? -> state.conversation(id)?.title?.takeIf { it.isNotEmpty() } ?: "a chat" }

    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        TabHeader("What ${state.agent(agentId)?.name ?: "your agent"} can decide alone")
        SectionCard {
            DecisionWords.delegable.forEachIndexed { i, category ->
                if (i > 0) Hairline()
                val mine = rules.filter { it.delegation?.category == category }
                val shown = if (category in expanded) mine else mine.take(3)
                Column {
                    Row(Modifier.defaultMinSize(minHeight = 48.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Icon(categoryIcon(category), null, tint = c.fgMuted, modifier = Modifier.size(18.dp))
                        Text(DecisionWords.name(category), style = junoText(TextSize.Md, FontWeight.SemiBold), color = c.fg, modifier = Modifier.weight(1f))
                        if (mine.isEmpty()) Text("Ask me", style = junoText(TextSize.Base), color = c.fgMuted)
                    }
                    shown.forEach { rule -> DelegationRow(rule, chatName) { editing = rule } }
                    if (mine.size > 3) Text(
                        if (category in expanded) "Show less" else "Show all ${mine.size}", style = junoText(TextSize.Sm, FontWeight.Medium), color = c.fg,
                        modifier = Modifier.defaultMinSize(minHeight = 36.dp).clickable { expanded = if (category in expanded) expanded - category else expanded + category }.padding(vertical = 8.dp),
                    )
                }
            }
        }
        Text("Always asks you", style = junoText(TextSize.Sm, FontWeight.SemiBold), color = c.fgMuted)
        SectionCard {
            DecisionWords.alwaysAsk.forEachIndexed { i, category ->
                if (i > 0) Hairline()
                Row(Modifier.defaultMinSize(minHeight = 44.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Icon(categoryIcon(category), null, tint = c.fgSubtle, modifier = Modifier.size(18.dp))
                    Text(DecisionWords.badge(category), style = junoText(TextSize.Md), color = c.fgMuted, modifier = Modifier.weight(1f))
                    Text(DecisionWords.alwaysAsksNote(category), style = junoText(TextSize.Sm), color = c.fgSubtle)
                }
            }
        }
    }
    editing?.let { DelegationEditSheet(it, agentId) { editing = null } }
}

@Composable
private fun DelegationRow(rule: Rule, chatName: (String?) -> String, onClick: () -> Unit) {
    val c = JunoTheme.colors
    val expired = parseIso(rule.expiresAt)?.let { it < Instant.now() } ?: false
    val platform = DecisionWords.platformName(rule.delegation?.platformKey, chatName)
    // Sharing between chats always has an end: "Files from #work → #general · expires Jan 20".
    val summary = listOfNotNull(DecisionWords.limitsSummary(rule, platform, chatName), if (rule.delegation?.category == "sharing") DecisionWords.expiresText(rule) else null).joinToString(" · ")
    val used = if ((rule.useCount ?: 0) > 0) "Used ${rule.useCount} times · ${Fmt.ago(rule.lastUsedAt)}" else "Not used yet"
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(categoryIcon(rule.delegation?.category), null, tint = c.fgMuted, modifier = Modifier.size(32.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(summary, style = junoText(TextSize.Base, FontWeight.Medium), color = c.fg)
            Text(if (expired) "Expired" else used, style = junoText(TextSize.Xs), color = if (expired) JunoStatus.warning else c.fgSubtle)
        }
        Icon(JunoIcons.ChevronRight, null, tint = c.fgSubtle)
    }
}
