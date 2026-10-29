package io.github.nigelleong0703.juno.ui.routines

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Routine
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.deleteRoutine
import io.github.nigelleong0703.juno.state.needsSetup
import io.github.nigelleong0703.juno.state.isOn
import io.github.nigelleong0703.juno.state.toggleRoutine
import io.github.nigelleong0703.juno.ui.agents.JunoSwitch
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.delay

/** Why a routine does not run: it waits for an app to be connected. Connecting itself is the Connectors feature's. */
@Composable
fun RoutineSetupNote(routine: Routine) {
    val missing = routine.missing.orEmpty()
    if (!routine.needsSetup || missing.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        missing.forEach { Text("Needs setup: connect ${it.label.orEmpty()}", style = junoText(TextSize.Base), color = JunoStatus.warning) }
    }
}

/** The on/off switch. The server toggles rather than sets, so it is disabled while a request is in flight (spec 5.1). */
@Composable
fun RoutineSwitch(routine: Routine) {
    val world = LocalWorld.current
    var busy by remember { mutableStateOf(false) }
    // One toggle at a time: the optimistic flip lands at once, the lock only guards against a double tap racing the server.
    LaunchedEffect(busy) { if (busy) { delay(800); busy = false } }
    JunoSwitch(routine.isOn, { busy = true; world.toggleRoutine(routine.id) }, enabled = !routine.needsSetup && !busy)
}

/** "Delete this schedule? It won't run again." */
@Composable
fun DeleteRoutineDialog(routine: Routine?, onDismiss: () -> Unit) {
    val world = LocalWorld.current
    routine ?: return
    AlertDialog(
        onDismissRequest = onDismiss, title = { Text("Delete this schedule? It won't run again.") },
        confirmButton = { TextButton({ world.deleteRoutine(routine.id); onDismiss() }) { Text("Delete", color = JunoStatus.danger) } },
        dismissButton = { TextButton(onDismiss) { Text("Cancel") } },
    )
}

/** Trailing state word of a routine row. */
fun routineStateWord(routine: Routine) = if (routine.needsSetup) "Needs setup" else if (routine.isOn) "On" else "Off"
