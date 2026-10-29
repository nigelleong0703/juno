package io.github.nigelleong0703.juno.ui.library

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.ui.components.EmptyState
import io.github.nigelleong0703.juno.ui.components.JunoIcons
import io.github.nigelleong0703.juno.ui.components.ShowMore
import io.github.nigelleong0703.juno.ui.components.openLink
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** A Space that has a hosted link: its title and the address it is shared at. */
private data class SharedLink(val id: String, val title: String, val url: String)

/**
 * The Library's Shared filter (owner-approved 2026-10-26, iOS `SharedSpaces`): the Spaces that have a hosted link, each
 * opened in the browser. Five at a time, with "Show more".
 */
@Composable
internal fun SharedSpaces() {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val c = JunoTheme.colors
    val context = LocalContext.current
    var limit by remember { mutableIntStateOf(5) }
    val links = state.spaces.mapNotNull { space ->
        val url = space.hosted?.url?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
        SharedLink(space.id, space.title.orEmpty(), url)
    }
    if (links.isEmpty()) {
        EmptyState(JunoIcons.Link, "Nothing shared yet", "Apps you publish as links show up here.")
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        links.take(limit).forEach { link ->
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.xl)).background(c.muted.copy(alpha = 0.7f))
                    .clickable { context.openLink(link.url) }.padding(12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(link.title, color = c.fg, style = junoText(TextSize.Md, FontWeight.SemiBold), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(link.url, color = c.fgMuted, style = junoText(TextSize.Sm), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Icon(JunoIcons.ArrowUpRight, null, tint = c.fgSubtle, modifier = Modifier.size(18.dp))
            }
        }
        ShowMore(shown = minOf(limit, links.size), total = links.size, onMore = { limit += 5 })
    }
}
