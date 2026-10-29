package io.github.nigelleong0703.juno.ui.agents

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.border
import io.github.nigelleong0703.juno.ui.components.Hairline
import io.github.nigelleong0703.juno.ui.components.PageScaffold
import io.github.nigelleong0703.juno.ui.components.ShowMore
import io.github.nigelleong0703.juno.ui.components.JunoSheet
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.AgentTask
import io.github.nigelleong0703.juno.contract.Run
import io.github.nigelleong0703.juno.contract.Step
import io.github.nigelleong0703.juno.state.Fmt
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.StatusTone
import io.github.nigelleong0703.juno.state.TaskGroups
import io.github.nigelleong0703.juno.state.TaskWords
import io.github.nigelleong0703.juno.state.startedByLine
import io.github.nigelleong0703.juno.state.agentsData
import io.github.nigelleong0703.juno.state.children
import io.github.nigelleong0703.juno.state.loadChildren
import io.github.nigelleong0703.juno.state.loadRun
import io.github.nigelleong0703.juno.state.loadSteps
import io.github.nigelleong0703.juno.state.previewImage
import io.github.nigelleong0703.juno.state.progressText
import io.github.nigelleong0703.juno.state.stepLine
import io.github.nigelleong0703.juno.state.visibleSteps
import io.github.nigelleong0703.juno.core.parseIso
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import java.time.Duration

/** A run as a pushed page (route `Route.Run`): the task card body under a back bar. */
@Composable
fun RunScreen(runId: String, onBack: () -> Unit) = PageScaffold("Task", onBack) { TaskCardContent(runId) }

/** Presents what a tapped task row opens: its run's card, or the meeting thread (spec 2.3). */
@Composable
fun TaskSheets(open: MutableState<AgentTask?>) {
    val task = open.value ?: return
    val close = { open.value = null }
    val runId = task.childRunId ?: task.runId
    when {
        runId != null -> JunoSheet("Task", close, long = true) { TaskCardContent(runId) }
        task.conversationId != null -> JunoSheet("Task", close, long = true) { ThreadTaskCardContent(task) }
    }
}

/** The line the agent wrote for this run: the result line once finished, progress while running (iOS `TaskCard.summary`). */
fun taskSummary(task: AgentTask?): String? {
    task ?: return null
    val text = if (TaskGroups.isActive(task)) task.progress?.let(::progressText) else task.resultLine ?: task.progress
    return text?.takeIf { it.isNotEmpty() }
}

private fun startedLine(run: Run?): String {
    val start = parseIso(run?.startedAt) ?: return ""
    val finish = parseIso(run?.finishedAt)
    val ms = run?.durationMs ?: finish?.let { Duration.between(start, it).toMillis() }
    val took = if (run?.status == "running") null else ms?.let { " · " + Fmt.duration(it) }
    return (finish?.let { "Finished ${Fmt.time(run?.finishedAt)}" } ?: "Started ${Fmt.time(run?.startedAt)}") + (took ?: "")
}

/** Status pill, title, when it started, error, the agent's summary, the latest screenshot, then the steps in plain words (spec 2.4). */
@Composable
fun TaskCardContent(runId: String) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    val run = state.run(runId) ?: state.childRuns[runId]
    val task = state.tasks.values.flatten().firstOrNull { (it.childRunId ?: it.runId) == runId }
    val children = state.children(runId)
    val routines by world.agentsData.collectAsState()
    // The task's own verdict wins: a run can end "completed" with the task failed (spec 5.6).
    val phase = task?.let(TaskWords::phase)
    val status = run?.status
    val shotId = run?.steps?.lastOrNull { it.screenshotRef != null }?.screenshotRef
    var viewing by remember { mutableStateOf(false) }
    LaunchedEffect(runId, run?.childRunIds) { world.loadRun(runId); world.loadSteps(runId); world.loadChildren(runId) }
    val shot by produceState(world.agentsData.value.previews[shotId], shotId) { value = shotId?.let { world.previewImage(it) } }

    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (phase != null) StatusPill(phase.first, phase.second) else StatusPill(if (status == "completed") "Completed" else Fmt.status(status), StatusTone.of(status))
        Text(run?.title ?: "Task", style = junoText(TextSize.Xl, FontWeight.Bold), color = c.fg)
        val by = task?.origin?.let { o -> startedByLine(o, routines.routines.firstOrNull { it.id == o.routineId }?.name) }
        Text(startedLine(run) + (by?.let { " · $it" } ?: ""), style = junoText(TextSize.Base), color = c.fgSubtle)
        task?.let(TaskWords::detail)?.let { Text(it, style = junoText(TextSize.Md), color = c.fgMuted) }
        run?.error?.let { Text(Fmt.runError(it), style = junoText(TextSize.Md), color = JunoStatus.danger) }
        (run?.summary ?: taskSummary(task))?.let { Text(it, style = junoText(TextSize.Md), color = c.fgMuted) }
        shot?.let { picture ->
            PictureImage(picture, Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.xl)).border(1.dp, c.border, RoundedCornerShape(Radius.xl)).clickable { viewing = true })
            if (viewing) ImageViewer(picture) { viewing = false }
        }
        StepSection("Main", null, run?.steps.orEmpty())
        children.forEach { StepSection(it.title ?: "Helper", it.status, it.steps.orEmpty()) }
    }
}

/** One titled list of steps, 8 at a time (iOS `StepSection`). */
@Composable
private fun StepSection(label: String, status: String?, steps: List<Step>) {
    val c = JunoTheme.colors
    var shown by remember { mutableIntStateOf(8) }
    val all = visibleSteps(steps)
    val live = status == "running" || status == "queued"
    if (all.isEmpty() && !live && status != "failed") return
    Hairline()
    Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, style = junoText(TextSize.Sm, FontWeight.Medium), color = c.fgSubtle, maxLines = 2)
        when {
            live -> Spinner(12.dp)
            status == "failed" -> Text("Failed", style = junoText(TextSize.Xs, FontWeight.Medium), color = JunoStatus.danger)
            status == "completed" -> Icon(JunoIcons.Check, null, tint = c.fgSubtle, modifier = Modifier.size(12.dp))
        }
    }
    all.take(shown).forEach { step ->
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("•", color = c.fgSubtle, style = junoText(TextSize.Base))
            Text(stepLine(step).orEmpty(), style = junoText(TextSize.Base), color = if (step.status == "failed") JunoStatus.danger else c.fg)
        }
    }
    ShowMore(minOf(shown, all.size), all.size, { shown += 8 })
}
