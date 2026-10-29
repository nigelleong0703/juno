package io.github.nigelleong0703.juno.ui.ideas

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import io.github.nigelleong0703.juno.contract.Idea
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.acceptIdea
import io.github.nigelleong0703.juno.state.ideaDraft
import io.github.nigelleong0703.juno.ui.components.JunoSheet
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** The draft an idea came with, read from the user's home when the sheet opens. "Use it" accepts the idea. */
@Composable
fun IdeaDraftSheet(idea: Idea, onDismiss: () -> Unit) {
    val world = LocalWorld.current
    val c = JunoTheme.colors
    var text by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(idea.id) {
        val path = idea.prepared?.ref
        text = if (path == null) "This draft is no longer there." else world.ideaDraft(path) ?: "This draft is no longer there."
    }
    JunoSheet(
        title = idea.prepared?.label?.takeIf { it.isNotEmpty() } ?: "Draft",
        onDismiss = onDismiss,
        long = true,
        trailing = {
            TextButton(onClick = { world.acceptIdea(idea); onDismiss() }) {
                Text("Use it", style = junoText(TextSize.Md, FontWeight.SemiBold), color = c.fg)
            }
        },
    ) {
        SelectionContainer {
            Text(text ?: "…", style = junoText(TextSize.Base), color = c.fg, modifier = Modifier.fillMaxWidth())
        }
    }
}
