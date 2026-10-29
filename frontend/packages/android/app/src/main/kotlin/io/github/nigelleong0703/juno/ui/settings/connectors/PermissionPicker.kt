package io.github.nigelleong0703.juno.ui.settings.connectors

import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** Read-only | Can take actions: the level an agent may use a connector or server with. */
@Composable
fun PermissionPicker(permission: String, enabled: Boolean = true, onChange: (String) -> Unit) {
    SegmentedControl(
        options = listOf(
            "read_only" to "Read-only",
            "full" to "Can take actions",
        ),
        selected = permission,
        onSelect = onChange,
        modifier = Modifier.padding(12.dp),
        enabled = enabled,
    )
}

/** The one sentence under the picker that explains the chosen level (iOS `permissionHelp`). */
fun permissionHelp(permission: String): String? = when (permission) {
    "read_only" -> "Your agents can look things up but cannot change anything."
    "full" -> "Your agents can also take actions, such as sending or creating. They still ask you first."
    else -> null
}
