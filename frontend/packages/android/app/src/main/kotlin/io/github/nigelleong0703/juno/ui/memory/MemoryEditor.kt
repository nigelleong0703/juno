package io.github.nigelleong0703.juno.ui.memory

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.AgentHomeFile
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage
import io.github.nigelleong0703.juno.state.HomeSave
import io.github.nigelleong0703.juno.state.HomeSaveResult
import io.github.nigelleong0703.juno.state.DailyNotes
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.PersonPage
import io.github.nigelleong0703.juno.state.homeFiles
import io.github.nigelleong0703.juno.state.writeHomeFile
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.launch

/**
 * Routes a memory file: MEMORY.md and the About-you bank are editable; a people page is editable above read-only
 * per-agent sections; anything else (daily notes, the learned reply style) is read-only.
 */
@Composable
fun MemoryFileScreen(path: String, match: MemoryMatch?, onBack: () -> Unit) {
    when {
        path == "MEMORY.md" -> HomeFileEditor(
            path = path, title = "Memory", onBack = onBack, match = match,
            hint = "The short sheet every agent reads first: facts, preferences and commitments. Edit it freely.",
            note = "About this file. This is the short sheet of what your agents remember about you. A background task keeps it up to date from your conversations. You can edit it at any time. This note is not part of the file.",
        )
        path.startsWith("memory/bank/") -> HomeFileEditor(path = path, title = bankTitle(path), onBack = onBack, match = match)
        path.startsWith("people/") -> HomeFileEditor(
            path = path, title = "Person", onBack = onBack, match = match,
            titleOf = { PersonPage.name(path, it) },
            editable = { PersonPage.split(it).body },
            merge = { edited, full -> PersonPage.join(edited, PersonPage.split(full).sections) },
            extra = { full -> PersonSections(PersonPage.split(full).sections) },
        )
        else -> ReadOnlyFile(
            path = path, onBack = onBack, match = match,
            title = if (path == "ALIGNMENT_SYNTHESIS.md") "Learned reply style" else DailyNotes.parse(path)?.date ?: path,
            hint = if (path == "ALIGNMENT_SYNTHESIS.md") "How you like to be answered, learned from your conversations. Read-only."
            else "What the agent wrote down that day. Read-only.",
        )
    }
}

/** The About-you files and their names. */
internal val BANK_FILES = listOf("circumstances" to "Circumstances", "experiences" to "Experiences", "preferences" to "Preferences")

internal fun bankTitle(path: String): String = BANK_FILES.firstOrNull { path == "memory/bank/${it.first}.md" }?.second ?: path

/**
 * A home file's text, edited in place (iOS `HomeFileEditor`). It is saved with the hash it was loaded with: when the file
 * changed elsewhere, the server refuses (409 `HOME_CONFLICT`), the file is reloaded and the user is asked to redo the
 * edit. [editable] is the part the user edits; [merge] puts the edited part back into the whole file; [extra] draws
 * what is below the field (it gets the whole loaded text).
 */
@Composable
fun HomeFileEditor(
    path: String,
    title: String,
    onBack: () -> Unit,
    hint: String? = null,
    note: String? = null,
    match: MemoryMatch? = null,
    titleOf: ((String) -> String)? = null,
    editable: (String) -> String = { it },
    merge: (String, String) -> String = { edited, _ -> edited },
    extra: @Composable (String) -> Unit = {},
) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    val scope = rememberCoroutineScope()
    var loaded by remember { mutableStateOf<AgentHomeFile?>(null) }
    var text by remember { mutableStateOf("") }
    // The served (editable) text last loaded or saved: a reload replaces the field only while the user has not typed.
    var lastLoaded by remember { mutableStateOf("") }
    var isLoading by remember { mutableStateOf(true) }
    var isSaving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    suspend fun fetch(resetText: Boolean) {
        try {
            val file = world.homeFiles(path).firstOrNull { it.path == path }
            val served = editable(file?.content.orEmpty())
            loaded = file
            text = if (resetText) served else HomeSave.textAfterReload(text, lastLoaded, served)
            lastLoaded = served
            error = null
        } catch (e: Throwable) {
            if (!e.isCancellation) error = e.userMessage
        }
        isLoading = false
    }

    LaunchedEffect(path, state.homeRevision) { fetch(resetText = false) }

    fun save() {
        val file = loaded
        isSaving = true
        error = null
        scope.launch {
            val outcome = try {
                world.writeHomeFile(path, merge(text, file?.content.orEmpty()), file?.hash)
                HomeSaveResult.Saved
            } catch (e: Throwable) {
                HomeSave.classify(e)
            }
            when (outcome) {
                HomeSaveResult.Saved -> fetch(resetText = true)
                HomeSaveResult.Conflict -> { fetch(resetText = true); error = HomeSave.CONFLICT_MESSAGE }
                is HomeSaveResult.Failed -> error = outcome.message
                null -> Unit
            }
            isSaving = false
        }
    }

    val shownTitle = titleOf?.invoke(loaded?.content.orEmpty())?.takeIf { it.isNotEmpty() } ?: title
    val canSave = !isLoading && !isSaving && text != editable(loaded?.content.orEmpty())
    Column(Modifier.fillMaxSize().background(c.canvas).padding(horizontal = 16.dp, vertical = 8.dp)) {
        MemoryBar(
            shownTitle, onBack = onBack,
            trailing = { TextButton(onClick = { save() }, enabled = canSave) { Text("Save", style = junoText(TextSize.Md, FontWeight.SemiBold), color = c.fg) } },
        )
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            note?.let { FileNote(it) }
            match?.let { MatchBlock(it) }
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                enabled = !isLoading && !isSaving,
                placeholder = { Text("Nothing here yet", color = c.fgSubtle) },
                textStyle = junoText(TextSize.Base).copy(color = c.fg),
                shape = RoundedCornerShape(Radius.lg),
                modifier = Modifier.fillMaxWidth().heightIn(min = 180.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedContainerColor = c.muted, unfocusedContainerColor = c.muted,
                    disabledContainerColor = c.muted, focusedBorderColor = c.muted, unfocusedBorderColor = c.muted,
                    disabledBorderColor = c.muted, cursorColor = c.fg,
                ),
                keyboardOptions = KeyboardOptions.Default,
            )
            if (isLoading) Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = c.fgMuted) }
            hint?.let { Text(it, style = junoText(TextSize.Xs), color = c.fgSubtle) }
            extra(loaded?.content.orEmpty())
            error?.let { Text(it, style = junoText(TextSize.Sm), color = JunoStatus.danger) }
        }
    }
}

/** "Found at line N" with the hit's snippet, above the file. */
@Composable
private fun MatchBlock(match: MemoryMatch) {
    val c = JunoTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("Found at line ${match.line}", style = junoText(TextSize.Sm, FontWeight.SemiBold), color = c.fg)
        Text(
            match.text, style = junoText(TextSize.Sm), color = c.fgMuted,
            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.tile)).background(c.tile).padding(12.dp),
        )
    }
}

/** A file the user may read but not change. */
@Composable
private fun ReadOnlyFile(path: String, title: String, hint: String, onBack: () -> Unit, match: MemoryMatch?) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    var text by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(path, state.homeRevision) {
        text = runCatching { world.homeFiles(path).firstOrNull { it.path == path }?.content.orEmpty().trim() }.getOrDefault("")
    }
    Column(Modifier.fillMaxSize().background(c.canvas).padding(horizontal = 16.dp, vertical = 8.dp)) {
        MemoryBar(title, onBack = onBack)
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            match?.let { MatchBlock(it) }
            val body = text
            if (body == null) {
                Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = c.fgMuted) }
            } else {
                Text(
                    body.ifEmpty { "Nothing here yet." }, style = junoText(TextSize.Base),
                    color = if (body.isEmpty()) c.fgMuted else c.fg,
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.tile)).background(c.tile).padding(14.dp),
                )
            }
            Text(hint, style = junoText(TextSize.Xs), color = c.fgSubtle)
        }
    }
}

/** A people page's per-agent sections: read-only, each with the footer that says who wrote it. */
@Composable
private fun PersonSections(sections: List<PersonPage.Section>) {
    val c = JunoTheme.colors
    sections.forEach { section ->
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(section.heading, style = junoText(TextSize.Sm, FontWeight.SemiBold), color = c.fgMuted)
            Text(
                section.text, style = junoText(TextSize.Base), color = c.fg,
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.tile)).background(c.tile).padding(14.dp),
            )
            Text("Written by this agent from its own dealings with this person. Read-only.", style = junoText(TextSize.Xs), color = c.fgSubtle)
        }
    }
}
