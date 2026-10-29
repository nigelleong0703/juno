package io.github.nigelleong0703.juno.ui.agents

import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.ui.theme.JunoTheme

/** The agent card sheet (iOS `AgentCardView`): the profile with no title, opened from an avatar in a chat. Dismiss with swipe down. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentCard(agentId: String, tab: String? = null, onDismiss: () -> Unit) {
    ModalBottomSheet(
        onDismissRequest = onDismiss, containerColor = JunoTheme.colors.canvas, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        shape = RoundedCornerShape(topStart = 32.dp, topEnd = 32.dp),
    ) { Box(Modifier.fillMaxWidth().height(640.dp)) { AgentProfile(agentId, tab, onClose = onDismiss) } }
}
