@file:OptIn(ExperimentalMaterial3Api::class)

package io.github.nigelleong0703.juno.ui.settings.models

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.material3.ExperimentalMaterial3Api

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.clickable
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/**
 * A short list of choices in a bottom sheet with a check on the current one (the iOS `Menu` and small pickers). The
 * null option is for "not set" choices such as "Provider default" or "Auto".
 */
@Composable
fun <T> OptionSheet(
    title: String,
    options: List<Pair<T?, String>>,
    selected: T?,
    onPick: (T?) -> Unit,
    onDismiss: () -> Unit,
) {
    val c = JunoTheme.colors
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = c.card) {
        Column(Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
            SheetTitle(title)
            options.forEach { (value, label) ->
                Row(
                    Modifier.fillMaxWidth().clickable { onPick(value); onDismiss() }.padding(horizontal = 20.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(label, style = junoText(TextSize.Md), color = c.fg, modifier = Modifier.weight(1f))
                    if (value == selected) {
                        Spacer(Modifier.size(12.dp))
                        Icon(JunoIcons.Check, contentDescription = "Selected", tint = c.fg)
                    }
                }
            }
        }
    }
}
