package io.github.nigelleong0703.juno.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Item
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.loadSteps
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import java.time.LocalDate

/** Everything a transcript row can ask of its screen; the screen owns the sheets and navigation these open. */
class ChatActions(
    val chatId: String,
    val isGroup: Boolean,
    /** My emoji per message id (kept on this device; the server has no reactions yet). */
    val reactions: Map<String, String>,
    val onReply: (Item) -> Unit,
    val onSend: (String) -> Unit,
    val onOpenAgent: (String) -> Unit,
    val onOpenSteps: (String) -> Unit,
    /** My emoji on a message (toggled from its menu). */
    val onReact: (Item, String) -> Unit,
    val onRetry: (Item) -> Unit,
    val onDiscard: (Item) -> Unit,
    val onOpenFeedPost: (String) -> Unit,
    val onOpenRoutines: () -> Unit,
    val onSystemAction: (Item) -> Unit,
    /** One-agent chats take that agent's tint for my bubbles (iOS `world.accent(for:)`); groups stay neutral. */
    val accent: Color? = null,
)

/** The kind of row a [ChatEntry] is, so the lazy list reuses composition of the same kind (item types differ in shape). */
fun ChatEntry.rowType(): String = when {
    typingRunId != null -> "typing"
    statusRunId != null -> "status"
    else -> item?.type ?: "entry"
}

/**
 * One transcript row: the day separator, then the typing row, the live status row or the item (iOS `ItemView` switch).
 * Takes the entry's fields and its [values] rather than the [ChatEntry], so an unchanged row skips on a state change.
 */
@Composable
fun ChatEntryRow(
    item: Item?,
    typingRunId: String?,
    statusRunId: String?,
    /** The day separator's date as epoch day (a `Long` keeps the row skippable; a `LocalDate` is unstable). */
    dayEpochDay: Long?,
    continuesGroup: Boolean,
    groupContinues: Boolean,
    values: RowValues,
    a: ChatActions,
) {
    val c = JunoTheme.colors
    // iOS ChatRow: 16dp sides, 6dp above and below a row, 1dp inside a reply's group (so 12dp between replies, 2dp within).
    Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(top = if (continuesGroup) 1.dp else 6.dp, bottom = if (groupContinues) 1.dp else 6.dp)) {
        androidx.compose.foundation.layout.Column(verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(6.dp)) {
            dayEpochDay?.let { epoch -> val day = LocalDate.ofEpochDay(epoch)
                // iOS DateSeparator: a muted capsule, xs medium, 4dp above and below.
                Box(Modifier.fillMaxWidth().padding(vertical = 4.dp), contentAlignment = Alignment.Center) {
                    Text(
                        ChatFormat.dayLabel(day), color = c.fgMuted, style = junoText(TextSize.Xs, androidx.compose.ui.text.font.FontWeight.Medium),
                        modifier = Modifier.clip(RoundedCornerShape(percent = 50)).background(c.muted).padding(horizontal = 10.dp, vertical = 3.dp),
                    )
                }
            }
            when {
                typingRunId != null -> TypingRow()
                statusRunId != null -> RunStatusRow(statusRunId, values.run) { a.onOpenSteps(statusRunId) }
                item != null -> ItemView(item, continuesGroup, values, a)
            }
        }
    }
}

@Composable
private fun ItemView(item: Item, continuesGroup: Boolean, values: RowValues, a: ChatActions) {
    val world = LocalWorld.current
    when (item.type) {
        "user_message" -> SwipeToReply({ a.onReply(item) }) { UserBubble(item, showAuthor = a.isGroup, values = values, a = a) }
        "agent_message" -> {
            LaunchedEffect(item.runId) { item.runId?.let { world.loadSteps(it) } }
            SwipeToReply({ a.onReply(item) }) {
                AgentBubble(item, showAuthor = a.isGroup && !continuesGroup, values = values, a = a)
            }
        }
        "run" -> values.run?.let { run -> FailedRunRow(run) { a.onOpenSteps(run.id) } }
        "plan" -> PlanCard(item, runTitle = values.run?.title)
        // iOS `.modifier(MessageWidth(trailing: false))`: the agent's bubble width, left-aligned.
        "request" -> values.request?.let { MessageColumn(trailing = false) { RequestCard(it, values.requestAgentName, values.requestQuiet) } }
        "artifact" -> ArtifactItemCard(item, values.library, values.libraryAgentName)
        "routine" -> RoutineCard(item, a)
        "handoff" -> HandoffRow(values.handoffFrom, values.handoffTo)
        "system" -> SystemRow(item, a)
        "feed_ref" -> FeedRefCard(item, a)
        "role_suggestion" -> RoleSuggestionCard(item, values.agent)
        else -> Unit
    }
}
