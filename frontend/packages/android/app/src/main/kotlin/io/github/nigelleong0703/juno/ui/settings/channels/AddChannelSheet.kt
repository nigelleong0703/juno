package io.github.nigelleong0703.juno.ui.settings.channels

import io.github.nigelleong0703.juno.ui.components.GroupedSection
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.state.ChannelPlatform
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import java.util.UUID

/**
 * "Connect": the platform list, then the chosen platform's flow in the same sheet (iOS pushes ChannelFlow from the list).
 * [onDismiss] runs however the sheet closes, so the section can reload its list.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AddChannelSheet(agentId: String, onDismiss: () -> Unit) {
    val c = JunoTheme.colors
    var platform by remember { mutableStateOf<ChannelPlatform?>(null) }
    // A new key per platform pick: a flow never reuses the state of an earlier one.
    val session = remember(platform) { UUID.randomUUID().toString() }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = c.canvas,
    ) {
        val chosen = platform
        if (chosen == null) {
            PlatformList(onPick = { platform = it })
        } else {
            ChannelFlowScreen(
                agentId = agentId, platform = chosen, session = session,
                onBack = { platform = null }, onDone = onDismiss,
            )
        }
    }
}

@Composable
private fun PlatformList(onPick: (ChannelPlatform) -> Unit) {
    val c = JunoTheme.colors
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Connect", style = junoText(TextSize.Lg, FontWeight.SemiBold), color = c.fg)
        GroupedSection(footer = "Pick where people will talk to this agent. One tap, nothing to copy.") {
            ChannelPlatform.entries.forEachIndexed { i, platform ->
                if (i > 0) HorizontalDivider(color = c.border)
                Row(
                    Modifier.fillMaxWidth().clickable { onPick(platform) }.padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    ChannelMark(platform)
                    Spacer(Modifier.size(12.dp))
                    Text(platform.title, style = junoText(TextSize.Md), color = c.fg)
                }
            }
        }
    }
}
