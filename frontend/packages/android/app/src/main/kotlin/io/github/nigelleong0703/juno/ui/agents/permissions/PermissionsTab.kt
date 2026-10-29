package io.github.nigelleong0703.juno.ui.agents.permissions

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.loadDecided
import io.github.nigelleong0703.juno.state.loadDelegations
import io.github.nigelleong0703.juno.state.loadGrants
import io.github.nigelleong0703.juno.state.resolve
import io.github.nigelleong0703.juno.state.sentence
import io.github.nigelleong0703.juno.ui.agents.TabHeader
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.ButtonSize
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/**
 * What the agent may decide alone, what waits on you, the history of decisions, the browsing / reaching-out tiers and
 * older per-tool rules (spec 2.18). Loads decided requests, rules and delegations on appear.
 */
@Composable
fun PermissionsTab(agentId: String) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    LaunchedEffect(agentId) { world.loadDecided(agentId); world.loadGrants(agentId); world.loadDelegations(agentId) }
    val pending = state.pendingOf(agentId)

    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        AuthorityTable(agentId)
        if (pending.isNotEmpty()) {
            TabHeader("Waiting on you")
            // The full request card is the chat feature's; here the sentence with the two decisions.
            pending.forEach { r ->
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(r.sentence, style = junoText(TextSize.Base, FontWeight.Medium), color = c.fg, maxLines = 3, overflow = TextOverflow.Ellipsis)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        JunoButton("Allow", { world.resolve(r.id, "approved") }, size = ButtonSize.Regular)
                        JunoButton("Deny", { world.resolve(r.id, "denied") }, variant = ButtonVariant.Secondary, size = ButtonSize.Regular)
                    }
                }
            }
        }
        DecisionHistory(agentId)
        TabHeader("Browsing and reaching out")
        TierSettings(agentId)
        OlderRules(agentId)
    }
}
