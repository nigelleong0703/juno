package io.github.nigelleong0703.juno.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Agent
import io.github.nigelleong0703.juno.ui.character.CharacterSprite
import io.github.nigelleong0703.juno.ui.character.SpriteView
import io.github.nigelleong0703.juno.ui.theme.JunoTheme

/** The character an agent is drawn as: the saved choice, else the id-derived default (iOS `agentCharacter`). */
fun agentCharacter(agent: Agent?): String = agent?.avatar?.character ?: CharacterSprite.defaultCharacter(agent?.id.orEmpty())

/** iOS `CharacterSprite.clip(for:)`: idle rests on the poster. */
private fun clipFor(status: String?): String? = when (status) {
    "working" -> "working"; "needs_you" -> "needs_you"; "sleeping", "paused" -> "sleeping"; "error" -> "failed"; else -> null
}

/** Soft per-character accent (web CHARACTER_TINT): agent card wash, Today stories ring, calendar blocks, live-screen ring. */
fun agentTint(agent: Agent?): Color = when (agentCharacter(agent)) {
    "mint" -> Color(0xFF4FD1B0); "blue" -> Color(0xFF5B8DEF); "purple" -> Color(0xFF9B7BF0)
    "pink" -> Color(0xFFF08BB4); "star" -> Color(0xFFF5B48A); else -> Color(0xFFF5C542)
}

/**
 * Agent avatar (iOS `AvatarView`): the animated character; under 40dp, or with [animated] false, it stays on the still
 * poster. [tile] draws the poster on a round tile-colour disc (list rows and feed bylines).
 */
@Composable
fun AgentAvatar(agent: Agent?, size: Dp, modifier: Modifier = Modifier, animated: Boolean = true, tile: Boolean = false) {
    val clip = if (animated && size >= 40.dp) clipFor(agent?.status) else null
    if (tile) {
        Box(modifier.size(size).clip(CircleShape).background(JunoTheme.colors.tile), contentAlignment = Alignment.Center) {
            SpriteView(character = agentCharacter(agent), clip = null, size = size)
        }
    } else {
        SpriteView(agentCharacter(agent), clip, size, modifier)
    }
}
