package io.github.nigelleong0703.juno.ui.agents.permissions

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.clickable
import io.github.nigelleong0703.juno.ui.components.Hairline
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
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
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.agentsData
import io.github.nigelleong0703.juno.state.refreshMyMac
import io.github.nigelleong0703.juno.state.setMacAccess
import io.github.nigelleong0703.juno.state.setTier
import io.github.nigelleong0703.juno.ui.agents.JunoSwitch
import io.github.nigelleong0703.juno.ui.agents.SectionCard
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** "Can use your Mac", Browsing (Strict | Normal) and Reaching out (On | Off) (spec 2.18). Each change PATCHes only that tier. */
@Composable
fun TierSettings(agentId: String) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val data by world.agentsData.collectAsState()
    val c = JunoTheme.colors
    val agent = state.agent(agentId)
    val tiers = agent?.permissionTiers
    val on = agent?.macAccess == true
    val mac = data.myMac
    val paired = mac?.paired == true
    LaunchedEffect(Unit) { world.refreshMyMac() }

    SectionCard {
        Column(Modifier.padding(bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(Modifier.defaultMinSize(minHeight = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Can use your Mac", style = junoText(TextSize.Md), color = c.fg, modifier = Modifier.weight(1f))
                JunoSwitch(on, { world.setMacAccess(agentId, it) }, enabled = paired || on)
            }
            Text("Files and commands on your Mac always ask first, except inside ~/Juno.", style = junoText(TextSize.Sm), color = c.fgMuted)
            if (!paired && !on) Text("Connect your Mac in Settings first.", style = junoText(TextSize.Sm), color = c.fgMuted)
            if (on && !(paired && mac?.online == true)) Text("Your Mac is offline. Open Juno on it so this agent can use it again.", style = junoText(TextSize.Sm), color = JunoStatus.warning)
        }
        Hairline()
        PickerRow("Browsing", if (tiers?.browsing == "strict") "strict" else "normal", listOf("strict" to "Strict", "normal" to "Normal")) { v -> world.setTier(agentId) { it.copy(browsing = v) } }
        Hairline()
        PickerRow("Reaching out", if (tiers?.reachOut == "off") "off" else "on", listOf("on" to "On", "off" to "Off")) { v ->
            // On restores "normal" unless the previous value was something other than off/absent.
            world.setTier(agentId) { it.copy(reachOut = if (v == "off") "off" else if (tiers?.reachOut == "off" || tiers?.reachOut == null) "normal" else tiers?.reachOut) }
        }
    }
}

@Composable
private fun PickerRow(title: String, selected: String, options: List<Pair<String, String>>, onSelect: (String) -> Unit) {
    val c = JunoTheme.colors
    var open by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = junoText(TextSize.Md), color = c.fg, modifier = Modifier.weight(1f))
        Box {
            Row(Modifier.clickable { open = true }.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(options.first { it.first == selected }.second, style = junoText(TextSize.Md), color = c.fgMuted)
                Icon(JunoIcons.ChevronDown, null, tint = c.fgMuted)
            }
            DropdownMenu(open, { open = false }, containerColor = c.card) {
                options.forEach { (id, label) -> DropdownMenuItem(text = { Text(label) }, onClick = { open = false; onSelect(id) }) }
            }
        }
    }
}
