package io.github.nigelleong0703.juno.ui.chat

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.animation.core.LinearEasing
import io.github.nigelleong0703.juno.state.Fmt
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Run
import io.github.nigelleong0703.juno.core.parseIso
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.WorldState
import io.github.nigelleong0703.juno.state.loadSteps
import io.github.nigelleong0703.juno.state.send
import io.github.nigelleong0703.juno.state.stopRun
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.delay
import java.time.Instant
import kotlin.math.sin

/** The reply slot while the agent has not produced text yet: an iMessage-style three-dot bubble. */
@Composable
fun TypingRow() {
    val c = JunoTheme.colors
    val t by rememberInfiniteTransition(label = "typing").animateFloat(0f, (2 * Math.PI).toFloat(), infiniteRepeatable(tween(1250, easing = LinearEasing), RepeatMode.Restart), label = "t")
    Row(
        Modifier.clip(androidx.compose.foundation.shape.RoundedCornerShape(Radius.xxl)).background(c.bubbleAgent).padding(horizontal = 12.dp, vertical = 11.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        repeat(3) { i -> Box(Modifier.size(7.dp).alpha(0.3f + 0.7f * (0.5f + 0.5f * sin(t - i * 1.2f))).background(c.bubbleAgentFg, CircleShape)) }
    }
}

/** The live status row: a spinner, what the agent is doing in words, how long it has been at it. Tap for the steps. */
@Composable
fun RunStatusRow(runId: String, run: Run?, onOpen: () -> Unit) {
    val world = LocalWorld.current
    val c = JunoTheme.colors
    LaunchedEffect(runId) { world.loadSteps(runId) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(1000); now = System.currentTimeMillis() } }
    val start = parseIso(run?.startedAt)
    Row(
        Modifier.clip(CircleShape).background(c.fgMuted.copy(alpha = 0.08f)).clickable(onClick = onOpen).padding(horizontal = 12.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = c.fgMuted)
        Text(run?.steps?.let { StepText.statusText(it) } ?: "Working…", color = c.fgMuted, style = junoText(TextSize.Sm), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        if (start != null) Text(ChatFormat.elapsed((now - start.toEpochMilli()) / 1000), color = c.fgSubtle, style = junoText(TextSize.Sm))
        Icon(JunoIcons.ChevronRight, null, tint = c.fgSubtle, modifier = Modifier.size(14.dp))
    }
}

/** "Worked 8m · 4 steps >" under the last reply of a finished run that did real work. */
@Composable
fun RunFooter(run: Run, workedMs: Long?, onOpen: () -> Unit) {
    val c = JunoTheme.colors
    Row(Modifier.clickable(onClick = onOpen).padding(start = 2.dp, top = 2.dp, bottom = 2.dp), horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(ChatFeed.footerText(run, workedMs), color = c.fgSubtle, style = junoText(TextSize.Xs))
        Icon(JunoIcons.ChevronRight, null, tint = c.fgSubtle, modifier = Modifier.size(12.dp))
    }
}

/** The one quiet line for a failed or stopped task with no reply. Failed offers Retry; stopped opens the steps. */
@Composable
fun FailedRunRow(run: Run, onOpenSteps: () -> Unit) {
    val world = LocalWorld.current
    val c = JunoTheme.colors
    val failed = run.status == "failed"
    Row(Modifier.padding(horizontal = 2.dp).clickable(enabled = !failed, onClick = onOpenSteps), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        if (failed) Icon(JunoIcons.Warning, null, tint = JunoStatus.danger, modifier = Modifier.size(14.dp))
        Text(
            if (failed) "Failed" + (run.error?.let { " · " + Fmt.runError(it) } ?: "") else "Stopped",
            color = if (failed) JunoStatus.danger else c.fgMuted, style = junoText(TextSize.Sm), maxLines = 2, modifier = Modifier.weight(1f, fill = false),
        )
        if (failed) Text("Retry", color = c.fg, style = junoText(TextSize.Sm, FontWeight.SemiBold), modifier = Modifier.clickable { retryRun(world, world.state.value, run, onOpenSteps) })
    }
}

/** The message that started a run: the user's message right before it. */
fun triggerMessage(state: WorldState, run: Run) = run.conversationId?.let { chat ->
    val start = parseIso(run.startedAt)?.plusSeconds(2) ?: return@let null
    state.items[chat].orEmpty().lastOrNull { it.type == "user_message" && (parseIso(it.at) ?: Instant.MAX) <= start }
}

/** "Retry" on a failed task: send the message that triggered it again; without it, the steps open instead. */
fun retryRun(world: io.github.nigelleong0703.juno.state.World, state: WorldState, run: Run, openSteps: () -> Unit) {
    val trigger = triggerMessage(state, run)
    val chat = run.conversationId
    val text = trigger?.text
    if (chat == null || text.isNullOrEmpty()) openSteps()
    else world.send(text, chat, trigger.attachments.orEmpty(), trigger.mentions.orEmpty())
}

/** The run's steps as a timeline (iOS run-steps sheet). */
@Composable
fun RunStepsSheet(runId: String, onDismiss: () -> Unit) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    val run = state.run(runId) ?: state.childRuns[runId]
    LaunchedEffect(runId) { world.loadSteps(runId) }
    ChatSheet(onDismiss, run?.title ?: "Activity", run?.let { listOfNotNull(Fmt.status(it.status), Fmt.duration(it.durationMs).ifEmpty { null }).joinToString(" · ") }) {
        val steps = StepText.visible(run?.steps.orEmpty())
        if (steps.isEmpty()) Text(if (run?.steps == null) "Loading…" else "No steps to show.", color = c.fgMuted, style = junoText(TextSize.Sm))
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            steps.forEach { step ->
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
                    when (step.status) {
                        "running" -> CircularProgressIndicator(Modifier.size(16.dp).padding(top = 2.dp), strokeWidth = 2.dp, color = c.fgMuted)
                        "failed" -> Icon(JunoIcons.Close, null, tint = JunoStatus.danger, modifier = Modifier.size(16.dp))
                        else -> Icon(JunoIcons.Check, null, tint = JunoStatus.success, modifier = Modifier.size(16.dp))
                    }
                    Text(StepText.line(step).orEmpty(), color = c.fg, style = junoText(TextSize.Base))
                }
            }
        }
        if (run != null && run.status in WorldState.ACTIVE_STATUSES) JunoButton("Stop", { world.stopRun(run.id); onDismiss() }, Modifier.fillMaxWidth(), ButtonVariant.Secondary)
    }
}
