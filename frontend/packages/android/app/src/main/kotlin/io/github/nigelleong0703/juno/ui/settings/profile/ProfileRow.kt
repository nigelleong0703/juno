package io.github.nigelleong0703.juno.ui.settings.profile

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.ProfileEntry
import io.github.nigelleong0703.juno.state.isShared
import io.github.nigelleong0703.juno.ui.settings.SettingsPill
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/**
 * One detail: key (1 line), value (3 lines), source line. Tap edits; long press asks to delete (the confirm is the
 * screen's). The visibility pill opens the "Only me / Shared" menu.
 */
@Composable
internal fun ProfileRow(
    entry: ProfileEntry,
    source: String,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
    onShared: (Boolean) -> Unit,
) {
    val c = JunoTheme.colors
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f).combinedClickable(onClick = onEdit, onLongClick = onDelete), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    entry.key.orEmpty(), style = junoText(TextSize.Md, FontWeight.Medium), color = c.fg,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Text(entry.value.orEmpty(), style = junoText(TextSize.Sm), color = c.fgMuted, maxLines = 3, overflow = TextOverflow.Ellipsis)
                Text(source, style = junoText(TextSize.Xs), color = c.fgSubtle, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Spacer(Modifier.width(12.dp))
            VisibilityMenu(entry.isShared, onShared)
        }
        HorizontalDivider(color = c.border)
    }
}

@Composable
private fun VisibilityMenu(shared: Boolean, onShared: (Boolean) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val c = JunoTheme.colors
    Box {
        SettingsPill(visibilityLabel(shared), onClick = { open = true })
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            listOf(false, true).forEach { option ->
                DropdownMenuItem(
                    text = { Text(visibilityLabel(option), color = c.fg) },
                    trailingIcon = { if (option == shared) Icon(JunoIcons.Check, null, tint = c.fg) },
                    onClick = {
                        open = false
                        if (option != shared) onShared(option)
                    },
                )
            }
        }
    }
}
