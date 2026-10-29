package io.github.nigelleong0703.juno.ui.agents.permissions

import io.github.nigelleong0703.juno.contract.Rule
import io.github.nigelleong0703.juno.ui.components.ConfirmDialog
import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.clickable
import io.github.nigelleong0703.juno.ui.components.ShowMore
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.state.Fmt
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.agentsData
import io.github.nigelleong0703.juno.state.revokeGrant
import io.github.nigelleong0703.juno.state.standingGrants
import io.github.nigelleong0703.juno.ui.agents.IconTile
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.ButtonSize
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** Per-tool "allowed without asking" rules from before delegations: read-only, revocable, none can be added (spec 2.18). */
@Composable
fun OlderRules(agentId: String) {
    val world = LocalWorld.current
    val data by world.agentsData.collectAsState()
    val c = JunoTheme.colors
    var open by remember { mutableStateOf(false) }
    var limit by remember { mutableIntStateOf(5) }
    var revoking by remember { mutableStateOf<Rule?>(null) }
    val grants = data.standingGrants(agentId)
    if (grants.isEmpty()) return
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Older rules (${grants.size})", style = junoText(TextSize.Md, FontWeight.SemiBold), color = c.fg, modifier = Modifier.fillMaxWidth().clickable { open = !open }.padding(top = 4.dp))
        if (open) {
            grants.take(limit).forEach { rule ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    IconTile(JunoIcons.Shield, size = 36.dp)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(rule.description ?: "Allowed without asking", style = junoText(TextSize.Md, FontWeight.SemiBold), color = c.fg)
                        rule.createdAt?.let { Text("Allowed ${Fmt.ago(it)}", style = junoText(TextSize.Sm), color = c.fgSubtle) }
                    }
                    JunoButton("Revoke", { revoking = rule }, variant = ButtonVariant.Secondary, size = ButtonSize.Sm)
                }
            }
            ShowMore(minOf(limit, grants.size), grants.size, { limit += 5 })
        }
    }
    revoking?.let { rule ->
        ConfirmDialog(
            title = "Revoke this rule?", body = "The agent asks you again before it does this.", confirm = "Revoke",
            onConfirm = { world.revokeGrant(rule, agentId); revoking = null }, onDismiss = { revoking = null },
        )
    }
}
