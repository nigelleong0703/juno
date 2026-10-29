package io.github.nigelleong0703.juno.ui.feed

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
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
import io.github.nigelleong0703.juno.contract.FeedPost
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.clearFeedFocus
import io.github.nigelleong0703.juno.state.openFeedPost
import io.github.nigelleong0703.juno.state.reloadFeed
import io.github.nigelleong0703.juno.state.replyToPost
import io.github.nigelleong0703.juno.state.undoDismiss
import io.github.nigelleong0703.juno.ui.components.EmptyState
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** How long a focused post stays highlighted (iOS `FeedPage.focus`). */
private const val FOCUS_MS = 3_000L

/**
 * The Feed page (iOS `FeedPage`), pushed from Today: posts the agents found that need no action, newest first. "Not for me" hides a post
 * at once with an Undo toast; posts with "less" stay hidden. The screen is self-contained: it reads and writes the
 * [io.github.nigelleong0703.juno.state.World] from [LocalWorld].
 */
@Composable
fun FeedScreen() {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    var refreshing by remember { mutableStateOf(false) }
    val snackbar = remember { SnackbarHostState() }
    var forwarding by remember { mutableStateOf<FeedPost?>(null) }
    var declining by remember { mutableStateOf<FeedPost?>(null) }
    val posts = state.feed.filter { it.post.feedback != "less" && (state.scope == null || it.post.agentId == state.scope) }
    val focus = state.feedFocus

    // "Not for me" stays on screen as a snackbar with Undo until the undo window closes (the toast is then cleared).
    LaunchedEffect(state.feedToast?.id) {
        val toast = state.feedToast ?: return@LaunchedEffect
        if (snackbar.showSnackbar(toast.text, actionLabel = "Undo", duration = SnackbarDuration.Indefinite) == SnackbarResult.ActionPerformed) {
            world.undoDismiss()
        }
    }
    LaunchedEffect(state.feedNotice) {
        val notice = state.feedNotice ?: return@LaunchedEffect
        snackbar.showSnackbar(notice, duration = SnackbarDuration.Short)
    }

    // A post asked for from a chat: scroll to it, then clear the highlight after 3 s.
    LaunchedEffect(focus, posts.size) {
        val id = focus ?: return@LaunchedEffect
        val index = posts.indexOfFirst { it.post.id == id }
        if (index < 0) return@LaunchedEffect
        listState.animateScrollToItem(index)
        delay(FOCUS_MS)
        world.clearFeedFocus(id)
    }

    Box(Modifier.fillMaxSize().background(c.canvas)) {
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { scope.launch { refreshing = true; world.reloadFeed(); refreshing = false } },
            modifier = Modifier.fillMaxSize(),
        ) {
            LazyColumn(
                state = listState,
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                if (posts.isEmpty()) {
                    item(key = "empty") {
                        // iOS ContentUnavailableView centres on the page, not under the heading.
                        Box(Modifier.fillParentMaxHeight(), contentAlignment = Alignment.Center) {
                            EmptyState(
                                JunoIcons.Newspaper, "Nothing new yet",
                                "Ask an agent to post here, e.g. “Every morning, send me AI news.”",
                            )
                        }
                    }
                }
                itemsIndexed(posts, key = { _, item -> item.post.id }, contentType = { _, _ -> "post" }) { _, item ->
                    val post = item.post
                    FeedRow(
                        item = item,
                        agent = state.agent(post.agentId),
                        highlighted = focus == post.id,
                        actions = FeedRowActions(
                            canReply = state.directConversation(post.agentId.orEmpty()) != null,
                            onOpen = { world.openFeedPost(post.id) },
                            onReply = { world.replyToPost(post) },
                            onForward = { forwarding = post },
                            onDecline = { declining = post },
                        ),
                    )
                }
            }
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter)) { data ->
            Snackbar(data, containerColor = c.card, contentColor = c.fg, actionContentColor = c.fg)
        }
    }

    forwarding?.let { post -> FeedForwardSheet(post) { forwarding = null } }
    declining?.let { post -> FeedReasonSheet(post) { declining = null } }
}
