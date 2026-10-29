package io.github.nigelleong0703.juno.ui.agents

import androidx.compose.foundation.layout.Arrangement
import io.github.nigelleong0703.juno.ui.components.EmptyLine
import io.github.nigelleong0703.juno.ui.components.ShowMore
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.AgentTask
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.TaskGroups
import io.github.nigelleong0703.juno.state.loadMoreTasks
import io.github.nigelleong0703.juno.state.loadTasks
import io.github.nigelleong0703.juno.state.stopTask

/** The agent's tasks: Now (uncapped), then finished ones by day, 12 at a time (spec 2.3). Live through `task.updated`. */
@Composable
fun ActivityTab(agentId: String) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    var limit by remember { mutableIntStateOf(12) }
    val open = remember { mutableStateOf<AgentTask?>(null) }
    val all = state.taskList(agentId)
    val layout = TaskGroups.layout(all, limit)
    LaunchedEffect(agentId) { world.loadTasks(agentId) }

    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        if (all.isEmpty()) EmptyLine("No tasks yet. Tasks show up here as the agent works.")
        if (layout.active.isNotEmpty()) {
            TabHeader("Now")
            layout.active.forEach { TaskEntryRows(it, { t -> open.value = t }, { t -> world.stopTask(t) }) }
        }
        layout.days.forEach { day ->
            TabHeader(day.title)
            day.entries.forEach { TaskEntryRows(it, { t -> open.value = t }, { t -> world.stopTask(t) }) }
        }
        if (layout.finishedTotal > limit) ShowMore(limit, layout.finishedTotal, { limit += 12 })
        // Everything loaded is shown: fetch the next page of older tasks.
        else if (state.taskNext[agentId] != null) ShowMore(0, 1, { world.loadMoreTasks(agentId); limit += 12 })
    }
    TaskSheets(open)
}
