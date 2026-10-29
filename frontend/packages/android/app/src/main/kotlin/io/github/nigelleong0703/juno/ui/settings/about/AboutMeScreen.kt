package io.github.nigelleong0703.juno.ui.settings.about

import io.github.nigelleong0703.juno.ui.components.GroupedPage
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.AgentHomeFile
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.homeFile
import io.github.nigelleong0703.juno.state.isHomeConflict
import io.github.nigelleong0703.juno.state.writeHomeFile
import io.github.nigelleong0703.juno.ui.settings.SettingsError
import io.github.nigelleong0703.juno.ui.settings.SettingsPill
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.launch

private const val USER_FILE = "USER.md"
private const val CONFLICT_MESSAGE = "This changed elsewhere and was reloaded. Review it and make your edit again."

/**
 * Settings → About you: USER.md, the free text every agent reads. Saved against the hash it was loaded with; if the file
 * changed elsewhere (409 HOME_CONFLICT) it is reloaded instead of overwritten, as iOS `HomeFileEditor` does.
 */
@Composable
fun AboutMeScreen(onBack: () -> Unit) {
    val world = LocalWorld.current
    val scope = rememberCoroutineScope()
    var loaded by remember { mutableStateOf<AgentHomeFile?>(null) }
    var text by remember { mutableStateOf("") }
    var isLoading by remember { mutableStateOf(true) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val served = loaded?.content.orEmpty()

    // Reloads replace the editor's text with the file (iOS resetText): an unsaved edit is not kept across a conflict.
    suspend fun load() {
        try {
            val file = world.homeFile(USER_FILE)
            loaded = file
            text = file?.content.orEmpty()
        } catch (e: Throwable) {
            if (!e.isCancellation) error = e.userMessage
        } finally {
            isLoading = false
        }
    }

    suspend fun save() {
        saving = true
        error = null
        try {
            world.writeHomeFile(USER_FILE, text, loaded?.hash)
            load()
        } catch (e: Throwable) {
            if (e.isCancellation) return
            if (e.isHomeConflict) {
                load()
                error = CONFLICT_MESSAGE
            } else {
                error = e.userMessage
            }
        } finally {
            saving = false
        }
    }

    LaunchedEffect(Unit) { load() }

    val c = JunoTheme.colors
    GroupedPage(
        title = "About you", onBack = onBack,
        actions = {
            SettingsPill("Save", enabled = !isLoading && !saving && text != served, onClick = { scope.launch { save() } })
        },
    ) {
        Text(
            "About this file. This is what you tell your agents about yourself, and every agent reads it. " +
                "Only you write it. You can edit it at any time. This note is not part of the file.",
            style = junoText(TextSize.Sm), color = c.fgMuted,
        )
        error?.let { SettingsError(it) }
        if (isLoading) {
            Box(Modifier.fillMaxWidth().padding(vertical = 24.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = c.fgMuted)
            }
        } else {
            SettingsTextArea(
                value = text,
                onValueChange = { text = it; error = null },
                minLines = 6,
                enabled = !saving,
            )
            Text(
                "Free text every agent reads. Your own words here outrank agent instructions and remembered facts.",
                style = junoText(TextSize.Xs), color = c.fgSubtle,
            )
        }
    }
}
