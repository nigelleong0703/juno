package io.github.nigelleong0703.juno.ui.settings.profile

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage
import io.github.nigelleong0703.juno.state.PROFILE_KEY_MAX
import io.github.nigelleong0703.juno.state.PROFILE_VALUE_MAX
import io.github.nigelleong0703.juno.state.ProfileDraft
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.JunoTextField
import io.github.nigelleong0703.juno.ui.settings.SettingsError
import io.github.nigelleong0703.juno.ui.settings.about.SettingsTextArea
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.launch

private const val VISIBILITY_HELP = "Only me: your agents use it only when working just for you. " +
    "Shared: also when they serve other people (group chats, Slack)."

/**
 * The add / edit sheet: name, value (may span lines) and who can use it. [onSave] throws the server's message for a refused
 * save, which is shown inline and keeps the sheet open; success closes it. Save needs a trimmed name and value within limits.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProfileEntrySheet(
    title: String,
    initial: ProfileDraft,
    onSave: suspend (ProfileDraft) -> Unit,
    onDismiss: () -> Unit,
) {
    val c = JunoTheme.colors
    val scope = rememberCoroutineScope()
    var draft by remember { mutableStateOf(initial) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }

    fun save() {
        scope.launch {
            busy = true
            message = null
            try {
                onSave(draft)
                onDismiss()
            } catch (e: Throwable) {
                if (!e.isCancellation) message = e.userMessage
            } finally {
                busy = false
            }
        }
    }

    ModalBottomSheet(onDismissRequest = { if (!busy) onDismiss() }, containerColor = c.canvas) {
        Column(
            Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(title, style = junoText(TextSize.Lg, FontWeight.SemiBold), color = c.fg)
            message?.let { SettingsError(it) }

            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                JunoTextField(
                    value = draft.key,
                    onValueChange = { draft = draft.copy(key = it); message = null },
                    label = "Name",
                )
                Text("${draft.key.length} / $PROFILE_KEY_MAX", style = junoText(TextSize.Xs), color = c.fgSubtle)
            }

            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                SettingsTextArea(
                    value = draft.value,
                    onValueChange = { draft = draft.copy(value = it); message = null },
                    label = "Value",
                    minLines = 3,
                )
                Text(
                    "An address can span several lines. ${draft.value.length} / $PROFILE_VALUE_MAX",
                    style = junoText(TextSize.Xs), color = c.fgSubtle,
                )
            }

            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Who can use this", style = junoText(TextSize.Sm, FontWeight.Medium), color = c.fgMuted)
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                    listOf(false, true).forEachIndexed { index, shared ->
                        SegmentedButton(
                            selected = draft.shared == shared,
                            onClick = { draft = draft.copy(shared = shared) },
                            shape = SegmentedButtonDefaults.itemShape(index = index, count = 2),
                        ) { Text(visibilityLabel(shared)) }
                    }
                }
                Text(VISIBILITY_HELP, style = junoText(TextSize.Xs), color = c.fgSubtle)
            }

            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                JunoButton("Cancel", onClick = onDismiss, variant = ButtonVariant.Secondary, enabled = !busy, modifier = Modifier.weight(1f))
                JunoButton("Save", onClick = { save() }, enabled = draft.canSave && !busy, modifier = Modifier.weight(1f))
            }
        }
    }
}
