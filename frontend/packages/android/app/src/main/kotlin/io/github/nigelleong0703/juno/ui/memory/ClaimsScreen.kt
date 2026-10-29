package io.github.nigelleong0703.juno.ui.memory

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.MemoryClaim
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage
import io.github.nigelleong0703.juno.core.parseIso
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.forgetMemory
import io.github.nigelleong0703.juno.state.memoryClaims
import io.github.nigelleong0703.juno.ui.components.RelativeTime
import io.github.nigelleong0703.juno.ui.components.ShowMore
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

private const val CLAIM_STEP = 10
private const val HISTORY_STEP = 5

/**
 * "What I know and why" (iOS `ClaimsList`): active claims with the words that back each one. Long-press a claim to
 * select claims, then Forget them after confirming. Retracted and superseded claims sit in a collapsed history.
 */
@Composable
fun ClaimsScreen(onBack: () -> Unit) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    val scope = rememberCoroutineScope()
    var claims by remember { mutableStateOf<List<MemoryClaim>?>(null) }
    var selection by remember { mutableStateOf(emptySet<String>()) }
    var confirming by remember { mutableStateOf(false) }
    var historyOpen by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var limit by remember { mutableIntStateOf(CLAIM_STEP) }
    var historyLimit by remember { mutableIntStateOf(HISTORY_STEP) }
    var refreshing by remember { mutableStateOf(false) }

    suspend fun load() {
        try {
            claims = world.memoryClaims()
            error = null
        } catch (e: Throwable) {
            if (!e.isCancellation) error = e.userMessage
            claims = claims ?: emptyList()
        }
    }
    LaunchedEffect(state.homeRevision) { load() }

    val active = claims.orEmpty().filter { it.status == "active" }
    val history = claims.orEmpty().filter { it.status != "active" }
    val chosen = selection.filter { id -> active.any { it.id == id } }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        MemoryBar(
            "What I know and why", onBack = if (selection.isEmpty()) onBack else null,
            trailing = {
                if (selection.isNotEmpty()) {
                    TextButton(onClick = { confirming = true }, enabled = chosen.isNotEmpty()) {
                        Text("Forget ${chosen.size}", style = junoText(TextSize.Md, FontWeight.SemiBold), color = JunoStatus.danger)
                    }
                    TextButton(onClick = { selection = emptySet() }) { Text("Done", color = c.fg) }
                }
            },
        )
        PullToRefreshBox(isRefreshing = refreshing, onRefresh = { scope.launch { refreshing = true; load(); refreshing = false } }, modifier = Modifier.weight(1f).fillMaxWidth()) {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (claims != null && active.isEmpty()) {
                    item { Text("Nothing learned yet.", style = junoText(TextSize.Base), color = c.fgMuted) }
                }
                items(active.take(limit), key = { it.id }) { claim ->
                    ClaimRow(
                        claim, selected = claim.id in selection,
                        onTap = { if (selection.isNotEmpty()) selection = toggled(selection, claim.id) },
                        onLongPress = { selection = toggled(selection, claim.id) },
                    )
                }
                item { ShowMore(shown = limit, total = active.size, onMore = { limit += CLAIM_STEP }) }
                item {
                    Text(
                        "What your agents concluded from what you said, with your own words as proof. Forgetting removes the claim and its lines from your memory files.",
                        style = junoText(TextSize.Xs), color = c.fgSubtle,
                    )
                }
                if (history.isNotEmpty()) {
                    item {
                        Row(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.tile)).background(c.tile)
                                .clickable { historyOpen = !historyOpen }
                                .padding(14.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text("History (${history.size})", style = junoText(TextSize.Md), color = c.fg, modifier = Modifier.weight(1f))
                            Icon(if (historyOpen) JunoIcons.ChevronDown else JunoIcons.ChevronRight, contentDescription = null, tint = c.fgSubtle)
                        }
                    }
                    if (historyOpen) {
                        items(history.take(historyLimit), key = { "h-${it.id}" }) { claim -> ClaimRow(claim, selected = false, dimmed = true) }
                        item { ShowMore(shown = historyLimit, total = history.size, onMore = { historyLimit += HISTORY_STEP }) }
                    }
                }
                error?.let { message -> item { Text(message, style = junoText(TextSize.Sm), color = JunoStatus.danger) } }
            }
        }
    }

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("Forget ${chosen.size} for good?") },
            confirmButton = {
                TextButton(onClick = {
                    confirming = false
                    scope.launch {
                        try {
                            world.forgetMemory(chosen)
                            selection = emptySet()
                            load()
                        } catch (e: Throwable) {
                            if (!e.isCancellation) error = e.userMessage
                        }
                    }
                }) { Text("Forget", color = JunoStatus.danger) }
            },
            dismissButton = { TextButton(onClick = { confirming = false }) { Text("Cancel", color = c.fg) } },
        )
    }
}

private fun toggled(set: Set<String>, id: String): Set<String> = if (id in set) set - id else set + id

/** One claim: its text, the quote that proves it (italic), and "NN% sure · path:line · 2d". */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ClaimRow(claim: MemoryClaim, selected: Boolean, dimmed: Boolean = false, onTap: () -> Unit = {}, onLongPress: () -> Unit = {}) {
    val c = JunoTheme.colors
    val evidence = claim.evidence?.firstOrNull()
    Column(
        Modifier.fillMaxWidth()
            .background(if (selected) c.selected else c.tile, RoundedCornerShape(Radius.tile))
            .combinedClickable(onClick = onTap, onLongClick = onLongPress)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(claim.text.orEmpty(), style = junoText(TextSize.Base), color = if (dimmed) c.fgMuted else c.fg)
        evidence?.quote?.let { quote ->
            val fromNote = evidence.itemId?.startsWith("log:") == true
            Text(
                "“$quote”" + if (fromNote) " (from a daily note)" else "",
                style = junoText(TextSize.Sm).copy(fontStyle = FontStyle.Italic), color = c.fgMuted,
            )
        }
        Text(caption(claim), style = junoText(TextSize.Xs), color = c.fgSubtle)
    }
}

/** "80% sure · notes/x.md:12 · 2d", the parts that the claim has. */
internal fun caption(claim: MemoryClaim): String {
    val parts = mutableListOf<String>()
    claim.confidence?.let { parts += "${(it * 100).roundToInt()}% sure" }
    claim.target?.path?.let { path -> parts += claim.target?.line?.let { "$path:$it" } ?: path }
    parseIso(claim.createdAt)?.let { parts += RelativeTime.short(it) }
    return parts.joinToString(" · ")
}
