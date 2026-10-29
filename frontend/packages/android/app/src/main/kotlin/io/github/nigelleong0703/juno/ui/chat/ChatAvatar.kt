package io.github.nigelleong0703.juno.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Agent
import io.github.nigelleong0703.juno.ui.components.AgentAvatar
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** A small status dot ringed with the canvas colour, as it sits on an avatar corner. */
@Composable
fun StatusBadge(color: Color, size: Dp = 12.dp, modifier: Modifier = Modifier) {
    Box(modifier.size(size).clip(CircleShape).background(color).border(2.dp, JunoTheme.colors.canvas, CircleShape))
}

/** The web `showDot` rule: green only while working, amber when it needs you, none for idle/sleeping/unknown. */
@Composable
fun AgentDot(agent: Agent?, needsYou: Boolean, size: Dp = 12.dp, modifier: Modifier = Modifier) {
    if (needsYou) StatusBadge(JunoStatus.warning, size, modifier)
    else if (agent?.status == "working") StatusBadge(JunoStatus.success, size, modifier)
}

/** Room avatar: two overlapping characters (iOS `GroupAvatar`). */
@Composable
fun GroupAvatar(agents: List<Agent>, size: Dp, modifier: Modifier = Modifier) {
    val small = size * 0.66f
    Box(modifier.size(size)) {
        AgentAvatar(agents.getOrNull(0), small, Modifier.align(Alignment.TopStart), animated = false)
        AgentAvatar(agents.getOrNull(1), small, Modifier.align(Alignment.BottomEnd), animated = false)
    }
}

/** A messaging platform's small round mark (the server's brand icons are not fetched on Android yet). */
@Composable
fun ChannelBadge(kind: String?, size: Dp = 16.dp, modifier: Modifier = Modifier) {
    val (letter, color) = when (kind) {
        "telegram" -> "T" to Color(0xFF2AABEE); "slack" -> "#" to Color(0xFF4A154B)
        "discord" -> "D" to Color(0xFF5865F2); "feishu" -> "F" to Color(0xFF3370FF); else -> "?" to Color.Gray
    }
    Box(modifier.size(size).clip(CircleShape).background(color), contentAlignment = Alignment.Center) {
        Text(letter, color = Color.White, style = junoText(TextSize.Xxs, FontWeight.Bold))
    }
}

fun platformName(kind: String?): String = when (kind) {
    "telegram" -> "Telegram"; "slack" -> "Slack"; "discord" -> "Discord"; "feishu" -> "Feishu / Lark"
    else -> kind.orEmpty().replaceFirstChar { it.uppercase() }
}

val PLATFORM_KINDS = listOf("telegram", "slack", "discord", "feishu")
