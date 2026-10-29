package io.github.nigelleong0703.juno.ui.settings.profile

import io.github.nigelleong0703.juno.ui.components.GroupedPage
import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.material3.TextButton
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.ProfileEntry
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.ProfileDraft
import io.github.nigelleong0703.juno.state.applyProfileDraft
import io.github.nigelleong0703.juno.state.loadProfile
import io.github.nigelleong0703.juno.state.saveProfile
import io.github.nigelleong0703.juno.state.setProfileVisibility
import io.github.nigelleong0703.juno.state.toDraft
import io.github.nigelleong0703.juno.ui.settings.SettingsError
import io.github.nigelleong0703.juno.ui.settings.SettingsPill
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.UUID

/** The editor sheet: which detail (null = a new one) and the draft it opened with. */
private data class Editor(val editingId: String?, val initial: ProfileDraft)

/**
 * Settings → Your details: one flat list of key → value details the agents fill into forms. Every change PUTs the whole
 * list (spec 2.6). The list is re-read on open, and each save is built from the list as it is when the write starts,
 * not when the editor opened; saves queue on [Mutex] so two quick edits cannot overwrite each other.
 * Details an agent learns while this screen is open are only picked up by the next open or save (no live event yet).
 */
@Composable
fun ProfileScreen(onBack: () -> Unit) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val scope = rememberCoroutineScope()
    val saves = remember { Mutex() }
    var entries by remember { mutableStateOf<List<ProfileEntry>?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var editor by remember { mutableStateOf<Editor?>(null) }
    var confirmDelete by remember { mutableStateOf<ProfileEntry?>(null) }
    var expanded by rememberSaveable { mutableStateOf(false) }

    suspend fun load() {
        try {
            entries = world.loadProfile()
            loadError = null
        } catch (e: Throwable) {
            if (!e.isCancellation && entries == null) loadError = e.userMessage
        }
    }

    // Reads the list inside the lock, so it is the list the previous save returned.
    suspend fun mutate(change: (List<ProfileEntry>) -> List<ProfileEntry>) = saves.withLock {
        val current = entries ?: return@withLock
        entries = world.saveProfile(change(current))
    }

    fun commit(change: (List<ProfileEntry>) -> List<ProfileEntry>) {
        scope.launch {
            try {
                mutate(change)
                error = null
            } catch (e: Throwable) {
                if (!e.isCancellation) error = e.userMessage
            }
        }
    }

    LaunchedEffect(Unit) { load() }

    val c = JunoTheme.colors
    GroupedPage(
        title = "Your details", onBack = onBack,
        actions = {
            IconButton(onClick = { editor = Editor(null, ProfileDraft()) }, enabled = entries != null) {
                Icon(JunoIcons.Plus, "Add detail", tint = c.fg)
            }
        },
    ) {
        error?.let { SettingsError(it) }
        val all = entries
        when {
            all != null -> ProfileList(
                entries = all, state = state, expanded = expanded,
                onToggleExpanded = { expanded = !expanded },
                onEdit = { entry -> editor = Editor(entry.id, entry.toDraft()) },
                onDelete = { entry -> confirmDelete = entry },
                onShared = { entry, shared -> commit { setProfileVisibility(it, entry.id, shared) } },
            )
            loadError != null -> {
                SettingsError(loadError.orEmpty())
                SettingsPill("Try again", onClick = { scope.launch { load() } })
            }
            else -> Box(Modifier.fillMaxWidth().padding(vertical = 24.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = c.fgMuted)
            }
        }
    }

    editor?.let { open ->
        ProfileEntrySheet(
            title = if (open.editingId == null) "Add detail" else "Edit detail",
            initial = open.initial,
            onSave = { draft ->
                mutate { applyProfileDraft(it, open.editingId, draft, UUID.randomUUID().toString()) }
            },
            onDismiss = { editor = null },
        )
    }

    confirmDelete?.let { entry ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            containerColor = c.card,
            title = { Text("Delete this detail?", style = junoText(TextSize.Lg, FontWeight.SemiBold), color = c.fg) },
            text = { Text("Your agents will no longer fill in ${entry.key.orEmpty()}.", style = junoText(TextSize.Base), color = c.fgMuted) },
            confirmButton = {
                TextButton(onClick = {
                    confirmDelete = null
                    commit { list -> list.filterNot { it.id == entry.id } }
                }) { Text("Delete", color = JunoStatus.danger) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text("Cancel", color = c.fgMuted) } },
        )
    }
}
