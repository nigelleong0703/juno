package io.github.nigelleong0703.juno.ui.agents

import androidx.compose.foundation.layout.Arrangement
import io.github.nigelleong0703.juno.ui.components.Hairline
import io.github.nigelleong0703.juno.ui.components.EmptyLine
import io.github.nigelleong0703.juno.ui.components.ShowMore
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.AgentTask
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.TaskWords
import io.github.nigelleong0703.juno.state.loadItems
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** A meeting task without a run: its conversation's messages, oldest first, the last 50 (spec 2.5). */
@Composable
fun ThreadTaskCardContent(task: AgentTask) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    val chat = task.conversationId.orEmpty()
    var limit by remember { mutableIntStateOf(50) }
    LaunchedEffect(chat) { world.loadItems(chat) }
    val said = state.items[chat].orEmpty().filter { it.type == "user_message" || it.type == "agent_message" }
    val shown = said.takeLast(limit)

    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        TaskWords.phase(task).let { (label, tone) -> StatusPill(label, tone) }
        Text(task.title ?: "Task", style = junoText(TextSize.Xl, FontWeight.Bold), color = c.fg)
        Text(TaskWords.subtitle(task), style = junoText(TextSize.Base), color = c.fgSubtle)
        Hairline()
        if (said.isEmpty()) EmptyLine("Nothing said yet.")
        ShowMore(shown.size, said.size, { limit += 50 }, "Show older")
        shown.forEach { item ->
            val who = if (item.type == "agent_message") state.agent(item.agentId)?.name.orEmpty() else item.channelSender?.name ?: "Someone"
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(who, style = junoText(TextSize.Sm, FontWeight.Medium), color = c.fgSubtle)
                // Agent markdown is shown as plain text here (spec 2.5).
                Text((if (item.type == "agent_message") item.markdown ?: item.text else item.text).orEmpty(), style = junoText(TextSize.Md), color = c.fg)
            }
        }
    }
}
