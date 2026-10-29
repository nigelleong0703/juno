package io.github.nigelleong0703.juno.ui.feed

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.FeedPost
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.dismissPost
import io.github.nigelleong0703.juno.state.forwardPost
import io.github.nigelleong0703.juno.ui.components.EmptyState
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.components.JunoSheet
import io.github.nigelleong0703.juno.ui.components.JunoTextField
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** "Why isn't this for you?": the reason goes to the agent with the "less" signal. [onDone] closes the sheet. */
@Composable
fun FeedReasonSheet(post: FeedPost, onDone: () -> Unit) {
    val world = LocalWorld.current
    val c = JunoTheme.colors
    var other by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf("") }
    fun choose(reason: String, text: String?) {
        world.dismissPost(post.id, reason, text?.trim()?.takeIf { it.isNotEmpty() })
        onDone()
    }
    JunoSheet(title = "Why isn’t this for you?", onDismiss = onDone) {
        if (other) {
            JunoTextField(
                value = note,
                onValueChange = { if (it.length <= NOTE_MAX) note = it },
                label = "What would you change?",
                modifier = Modifier.fillMaxWidth(),
            )
            JunoButton(text = "Done", onClick = { choose("other", note) }, modifier = Modifier.fillMaxWidth())
        } else {
            REASONS.forEach { (key, text) ->
                Text(
                    text, style = junoText(TextSize.Lg), color = c.fg,
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.tile)).background(c.tile)
                        .clickable { choose(key, null) }.padding(16.dp),
                )
            }
            Text(
                "Something else…", style = junoText(TextSize.Lg), color = c.fg,
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.tile)).background(c.tile)
                    .clickable { other = true }.padding(16.dp),
            )
        }
    }
}

/** Pick a chat and send the post there (title, summary, source link). Shows "Sent to <chat>" under the Feed header. */
@Composable
fun FeedForwardSheet(post: FeedPost, onDone: () -> Unit) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    JunoSheet(title = "Forward to", onDismiss = onDone, long = true) {
        val chats = state.recentConversations
        if (chats.isEmpty()) {
            EmptyState(JunoIcons.Chat, "No chats", "Start a chat with an agent first.")
        }
        chats.forEach { chat ->
            Text(
                state.title(chat), style = junoText(TextSize.Md, FontWeight.Medium), color = c.fg,
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.tile)).background(c.tile)
                    .clickable {
                        world.forwardPost(post, chat.id)
                        onDone()
                    }.padding(16.dp),
            )
        }
    }
}

private const val NOTE_MAX = 200

private val REASONS = listOf(
    "topic" to "Not interested in this topic",
    "frequency" to "Too often",
    "known" to "Already knew this",
    "source" to "Not a good source",
)
