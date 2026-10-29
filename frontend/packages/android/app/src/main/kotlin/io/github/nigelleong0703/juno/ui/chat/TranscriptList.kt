package io.github.nigelleong0703.juno.ui.chat

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.state.ChatHistory
import io.github.nigelleong0703.juno.state.WorldState
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

/**
 * The transcript: a reversed LazyColumn (index 0 = newest, at the bottom), rows keyed by [ChatEntry.id].
 * - Paging: the next older page is requested within 1.5 screens of the oldest row.
 * - Anchoring: a reader scrolled up keeps their place when newer rows land (the lazy list holds the first visible row by
 *   key); my own message, or any row while the reader is at the bottom, scrolls to the bottom ([TranscriptMath.followNewest]).
 * - Opening is silent: no scroll animation, a short fade once the first screenful is there.
 * - Jump-to-latest shows 140dp+ from the newest row, or when the window was trimmed at its newest end, and re-attaches it.
 */
@Composable
fun TranscriptList(
    entries: List<ChatEntry>,
    /** The screen's collected world: each row's values are looked up from it here, so the rows themselves never collect. */
    worldState: WorldState,
    history: ChatHistory?,
    isMine: (ChatEntry) -> Boolean,
    a: ChatActions,
    onLoadOlder: () -> Unit,
    onReattach: () -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(vertical = 8.dp),
) {
    val rows = remember(entries) { entries.asReversed() }
    val state = rememberLazyListState()
    val density = LocalDensity.current.density
    val scope = rememberCoroutineScope()
    val newest = rows.firstOrNull()

    // Paging.
    LaunchedEffect(state) {
        snapshotFlow { state.layoutInfo.let { (it.visibleItemsInfo.lastOrNull()?.index ?: -1) to it.visibleItemsInfo.size } }
            .distinctUntilChanged()
            .collect { (last, visible) -> if (TranscriptMath.shouldLoadOlder(last, visible, state.layoutInfo.totalItemsCount)) onLoadOlder() }
    }

    // Following the newest row.
    var processed by remember { mutableStateOf<String?>(null) }
    var wasAtBottom by remember { mutableStateOf(true) }
    LaunchedEffect(newest?.id) {
        val follow = TranscriptMath.followNewest(processed, newest?.id, newest?.let(isMine) == true, wasAtBottom)
        val first = processed == null
        processed = newest?.id
        if (follow && !first) state.animateScrollToItem(0)
    }
    LaunchedEffect(state) {
        snapshotFlow { TranscriptMath.atBottom(state.firstVisibleItemIndex, state.firstVisibleItemScrollOffset, density) }
            .collect { if (rows.firstOrNull()?.id == processed) wasAtBottom = it }
    }

    val distanceDp by remember { androidx.compose.runtime.derivedStateOf { if (state.firstVisibleItemIndex > 0) Float.MAX_VALUE else state.firstVisibleItemScrollOffset / density } }
    val showJump = rows.isNotEmpty() && TranscriptMath.showJump(distanceDp, history?.detached == true)
    val openAlpha by animateFloatAsState(if (rows.isNotEmpty()) 1f else 0f, tween(120), label = "open")

    Box(modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize().graphicsLayer { this.alpha = openAlpha }, state = state, reverseLayout = true, contentPadding = contentPadding) {
            items(rows, key = { it.id }, contentType = { it.rowType() }) { entry ->
                ChatEntryRow(
                    entry.item, entry.typingRunId, entry.statusRunId, entry.dayStart?.toEpochDay(), entry.continuesGroup, entry.groupContinues,
                    values = rowValues(worldState, entry.item, entry.statusRunId), a = a,
                )
            }
        }
        AnimatedVisibility(
            showJump, Modifier.align(Alignment.BottomEnd).padding(16.dp),
            enter = fadeIn() + scaleIn(initialScale = 0.6f), exit = fadeOut() + scaleOut(targetScale = 0.6f),
        ) {
            val c = JunoTheme.colors
            Box(
                Modifier.size(40.dp).clip(CircleShape).background(c.card).border(0.5.dp, c.border, CircleShape).clickable {
                    if (history?.detached == true) onReattach()
                    scope.launch { state.animateScrollToItem(0) }
                },
                contentAlignment = Alignment.Center,
            ) { Icon(JunoIcons.ChevronDown, "Jump to latest", tint = c.fg) }
        }
    }
}
