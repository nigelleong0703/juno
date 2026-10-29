package io.github.nigelleong0703.juno.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.nav.Tab
import io.github.nigelleong0703.juno.ui.theme.JunoTheme

/**
 * The iOS tab bar (`JunoTabBarController`), shown on the five tab roots only: a floating capsule of five icon-only tabs, 62 pt tall, 20 pt from the sides,
 * the selected tab a soft pill. A flat `card` surface with a hairline border and a soft shadow instead of glass.
 * [badgeFor] is the count on a tab (Chat: the requests waiting for you).
 */
@Composable
fun TabBar(selected: Tab, badgeFor: (Tab) -> Int, onSelect: (Tab) -> Unit) {
    val c = JunoTheme.colors
    val capsule = RoundedCornerShape(percent = 50)
    Row(
        Modifier
            .navigationBarsPadding()
            .padding(start = 20.dp, end = 20.dp, bottom = 12.dp)
            .fillMaxWidth()
            .height(62.dp)
            .shadow(elevation = 8.dp, shape = capsule, ambientColor = SHADOW, spotColor = SHADOW)
            .clip(capsule)
            .background(c.card)
            .border(1.dp, c.border, capsule)
            .padding(horizontal = 4.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        for (tab in Tab.entries) {
            val on = tab == selected
            Box(
                Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    .clip(capsule)
                    .background(if (on) c.selected else Color.Transparent)
                    .clickable(role = Role.Tab) { onSelect(tab) }
                    .semantics { contentDescription = tab.title },
                contentAlignment = Alignment.Center,
            ) {
                val badge = badgeFor(tab)
                BadgedBox(badge = { if (badge > 0) Badge { Text("$badge") } }) {
                    Icon(tab.icon, contentDescription = null, tint = c.fg, modifier = Modifier.size(26.dp))
                }
            }
        }
    }
}

private val SHADOW = Color.Black.copy(alpha = 0.10f)
