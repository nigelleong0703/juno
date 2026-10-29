package io.github.nigelleong0703.juno.ui.chat

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.graphics.ClipOp
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.sp
import io.github.nigelleong0703.juno.ui.theme.CenteredLines
import io.github.nigelleong0703.juno.ui.theme.Radius
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.github.nigelleong0703.juno.contract.Item
import io.github.nigelleong0703.juno.ui.components.JunoIcons
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import org.json.JSONObject
import kotlin.math.roundToInt

/** My emoji per message id. The server has no reactions yet, so (as on iOS) they live on this device only. */
class Reactions(private val context: Context) {
    val map = mutableStateMapOf<String, String>()

    init {
        runCatching {
            val json = JSONObject(prefs().getString(KEY, "{}") ?: "{}")
            json.keys().forEach { map[it] = json.getString(it) }
        }
    }

    /** Tapping the same emoji again removes it. */
    fun toggle(itemId: String, emoji: String) {
        if (map[itemId] == emoji) map.remove(itemId) else map[itemId] = emoji
        prefs().edit().putString(KEY, JSONObject(map.toMap()).toString()).apply()
    }

    private fun prefs() = context.getSharedPreferences("chat", Context.MODE_PRIVATE)

    companion object { private const val KEY = "reactions" }
}

private val QUICK = listOf("👍", "❤️", "😂", "😮", "😢", "🙏")
private val MORE = listOf("🔥", "🎉", "👀", "✅", "❌", "🤔", "💯", "👏", "🙌", "😅")

/** The gap between the pressed bubble and the reaction pill above it / the actions below it. */
private val GAP = 8.dp
/** The screen edge margin for the pill and the actions. */
private val EDGE_MARGIN = 16.dp

/**
 * A bubble with its own long-press menu (iOS `ReactionOverlay`): the screen dims except the bubble, a reaction pill floats
 * above it and the actions list sits below it. The menu is a dialog over the page, so the bubble keeps its place.
 */
@Composable
fun MessageMenuAnchor(item: Item, a: ChatActions, failed: Boolean, bubble: @Composable (onLongPress: () -> Unit) -> Unit) {
    var open by remember { mutableStateOf(false) }
    var anchor by remember { mutableStateOf(Rect.Zero) }
    Box(Modifier.onGloballyPositioned { anchor = it.boundsInWindow() }) {
        bubble { open = true }
    }
    if (open) {
        MessageMenu(
            item, failed = failed, anchor = anchor, onDismiss = { open = false },
            onReact = { a.onReact(item, it) }, onReply = { a.onReply(item) }, onRetry = { a.onRetry(item) }, onDiscard = { a.onDiscard(item) },
        )
    }
}

private class MenuAction(val title: String, val icon: ImageVector, val destructive: Boolean = false, val run: () -> Unit)

/**
 * The message menu: a row of reactions (6, "+" for 10 more) above the bubble and a list of actions below it (Reply,
 * Copy; Retry and Delete for a failed send). A long-press that opens it gives the Material LongPress haptic.
 */
@Composable
fun MessageMenu(
    item: Item, failed: Boolean, anchor: Rect, onDismiss: () -> Unit,
    onReact: (String) -> Unit, onReply: () -> Unit, onRetry: () -> Unit, onDiscard: () -> Unit,
) {
    val c = JunoTheme.colors
    val clipboard = LocalClipboardManager.current
    val haptic = LocalHapticFeedback.current
    val density = LocalDensity.current
    var more by remember { mutableStateOf(false) }
    val top = WindowInsets.statusBars.getTop(density)
    val bottom = WindowInsets.navigationBars.getBottom(density)
    LaunchedEffect(Unit) { haptic.performHapticFeedback(HapticFeedbackType.LongPress) }
    val actions = buildList {
        if (failed) {
            add(MenuAction("Retry", JunoIcons.Refresh) { onRetry() })
            add(MenuAction("Delete", JunoIcons.Trash, destructive = true) { onDiscard() })
        }
        add(MenuAction("Reply", JunoIcons.Reply) { onReply() })
        add(MenuAction("Copy", JunoIcons.Copy) { clipboard.setText(AnnotatedString(Quote.split(item.text ?: item.markdown.orEmpty()).body)) })
    }
    val radius = with(density) { Radius.xxl.toPx() }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Layout(
            content = {
                Pill(more, onMore = { more = true }) { e -> onReact(e); onDismiss() }
                Actions(actions) { it.run(); onDismiss() }
            },
            modifier = Modifier
                .fillMaxSize()
                // The dim leaves the pressed bubble clear, as iOS lifts it above the dim.
                .drawBehind {
                    val hole = Path().apply { addRoundRect(RoundRect(anchor, CornerRadius(radius))) }
                    clipPath(hole, ClipOp.Difference) { drawRect(Color.Black.copy(alpha = 0.4f)) }
                }
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onDismiss),
        ) { (pill, list), constraints ->
            val p = pill.measure(constraints.copy(minWidth = 0, minHeight = 0))
            val l = list.measure(constraints.copy(minWidth = 0, minHeight = 0))
            val gap = GAP.roundToPx()
            val margin = EDGE_MARGIN.roundToPx()
            val w = constraints.maxWidth
            val h = constraints.maxHeight
            // Both line up with the bubble's own side: trailing for a message on the right.
            val alignEnd = anchor.center.x > w / 2f
            fun x(width: Int) = (if (alignEnd) anchor.right - width else anchor.left).roundToInt().coerceIn(margin, (w - width - margin).coerceAtLeast(margin))
            val pillY = (anchor.top.roundToInt() - gap - p.height).coerceAtLeast(top + gap)
            // Below the bubble; a tall bubble near the bottom has its actions pulled up over it.
            val listY = (anchor.bottom.roundToInt() + gap).coerceAtMost(h - bottom - margin - l.height).coerceAtLeast(pillY + p.height + gap)
            layout(w, h) { p.place(x(p.width), pillY); l.place(x(l.width), listY) }
        }
    }
}

@Composable
private fun Pill(more: Boolean, onMore: () -> Unit, onReact: (String) -> Unit) {
    val c = JunoTheme.colors
    Column(
        Modifier.clip(CircleShape).background(c.card).border(1.dp, c.border, CircleShape).padding(horizontal = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            QUICK.forEach { e -> Emoji(e) { onReact(e) } }
            if (!more) {
                // iOS: a muted "+" in a small filled circle, quieter than the emoji.
                Box(Modifier.size(44.dp).clip(CircleShape).clickable(onClick = onMore), contentAlignment = Alignment.Center) {
                    Box(Modifier.size(32.dp).background(c.muted, CircleShape), contentAlignment = Alignment.Center) {
                        Icon(JunoIcons.Plus, "More reactions", tint = c.fgMuted, modifier = Modifier.size(18.dp))
                    }
                }
            }
        }
        if (more) MORE.chunked(5).forEach { line -> Row { line.forEach { e -> Emoji(e) { onReact(e) } } } }
    }
}

/** The actions list (iOS: 46 pt rows, the title leading and the symbol trailing, hairlines between). */
@Composable
private fun Actions(actions: List<MenuAction>, onPick: (MenuAction) -> Unit) {
    val c = JunoTheme.colors
    val shape = RoundedCornerShape(Radius.xxl)
    Column(Modifier.width(220.dp).clip(shape).background(c.card).border(1.dp, c.border, shape)) {
        actions.forEachIndexed { i, a ->
            if (i > 0) HorizontalDivider(color = c.border)
            val tint = if (a.destructive) JunoStatus.danger else c.fg
            Row(
                Modifier.fillMaxWidth().height(46.dp).clickable { onPick(a) }.padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(a.title, color = tint, style = junoText(TextSize.Md), modifier = Modifier.weight(1f))
                Icon(a.icon, contentDescription = null, tint = tint, modifier = Modifier.size(18.dp))
            }
        }
    }
}

@Composable
private fun Emoji(e: String, onClick: () -> Unit) {
    Box(Modifier.size(44.dp).clip(CircleShape).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Text(e, style = TextStyle(fontSize = 28.sp, lineHeight = 34.sp, lineHeightStyle = CenteredLines), textAlign = TextAlign.Center)
    }
}
