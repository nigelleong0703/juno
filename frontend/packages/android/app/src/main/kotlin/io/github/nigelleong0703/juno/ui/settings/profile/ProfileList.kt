package io.github.nigelleong0703.juno.ui.settings.profile

import io.github.nigelleong0703.juno.ui.components.GroupedSection
import androidx.compose.runtime.Composable
import io.github.nigelleong0703.juno.contract.ProfileEntry
import io.github.nigelleong0703.juno.state.WorldState
import io.github.nigelleong0703.juno.state.profileSourceLine
import io.github.nigelleong0703.juno.ui.settings.SettingsEmpty
import io.github.nigelleong0703.juno.ui.settings.ShowMoreButton

private const val CAP = 8
private const val EMPTY = "Nothing yet. Juno adds details here as it learns them, or add one yourself."
private const val FOOTER = "Your agents fill these into forms for you, so you do not retype them. They add what they learn here, " +
    "and you can edit or remove anything. Passwords and card details never go here."

/** The details, capped at [CAP] until "Show more". Tap edits, long press asks to delete, the menu sets who can use it. */
@Composable
internal fun ProfileList(
    entries: List<ProfileEntry>,
    state: WorldState,
    expanded: Boolean,
    onToggleExpanded: () -> Unit,
    onEdit: (ProfileEntry) -> Unit,
    onDelete: (ProfileEntry) -> Unit,
    onShared: (ProfileEntry, Boolean) -> Unit,
) {
    GroupedSection(footer = FOOTER) {
        if (entries.isEmpty()) SettingsEmpty(EMPTY)
        val shown = if (expanded) entries else entries.take(CAP)
        shown.forEach { entry ->
            ProfileRow(
                entry = entry,
                source = profileSourceLine(entry, state.agent(entry.source?.agentId)?.name),
                onEdit = { onEdit(entry) },
                onDelete = { onDelete(entry) },
                onShared = { onShared(entry, it) },
            )
        }
        if (entries.size > CAP) {
            ShowMoreButton(if (expanded) "Show fewer" else "Show ${entries.size - CAP} more", onToggleExpanded)
        }
    }
}

/** Shared by the row's menu and the editor's segmented control. */
internal fun visibilityLabel(shared: Boolean): String = if (shared) "Shared" else "Only me"
