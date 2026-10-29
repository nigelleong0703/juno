package io.github.nigelleong0703.juno.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * Semantic tokens, ported 1:1 from the iOS `Theme` (which mirrors packages/ui theme/tokens.css): neutral surfaces,
 * colour only on agent avatars and status, no blue anywhere. Names match iOS so a feature port is a rename-free copy.
 */
data class JunoColors(
    /** --background */ val canvas: Color,
    /** --panel-background */ val panel: Color,
    /** --card */ val card: Color,
    /** --muted / --secondary */ val muted: Color,
    /** --composer-background */ val composer: Color,
    /** The composer's hairline ring. */ val composerEdge: Color,
    /** Idle send button (--accent). */ val composerIdle: Color,
    /** --interactive-selected */ val selected: Color,
    /** --foreground */ val fg: Color,
    /** --muted-foreground */ val fgMuted: Color,
    /** --fg-subtle */ val fgSubtle: Color,
    /** --border */ val border: Color,
    /** --primary: the neutral pill, black in light and white in dark. */ val primary: Color,
    val primaryFg: Color,
    val bubbleAgent: Color,
    val bubbleAgentFg: Color,
    val bubbleUser: Color,
    val bubbleUserFg: Color,
    /** --bg-subtle */ val bgSubtle: Color,
    /** --interactive-hover */ val hover: Color,
    /** --input-background */ val inputBg: Color,
    val requestCard: Color,
    val tile: Color,
    val isDark: Boolean,
) {
    companion object {
        val light = JunoColors(
            canvas = hex(0xfcfcfc), panel = hex(0xf9f9f9), card = hex(0xffffff), muted = hex(0xf4f4f4),
            composer = hex(0xffffff), composerEdge = hex(0x000000, 0.04f), composerIdle = hex(0xf1f1f1),
            selected = hex(0xededed), fg = hex(0x0d0d0d), fgMuted = hex(0x5d5d5d), fgSubtle = hex(0x8f8f8f),
            border = hex(0x141414, 0.15f), primary = hex(0x070707), primaryFg = hex(0xffffff),
            bubbleAgent = hex(0xeeeeee), bubbleAgentFg = hex(0x141414), bubbleUser = hex(0x070707), bubbleUserFg = hex(0xfcfcfc),
            bgSubtle = hex(0xf4f4f4), hover = hex(0xf1f1f1), inputBg = hex(0xfcfcfc),
            requestCard = hex(0xffffff), tile = hex(0xf4f4f4), isDark = false,
        )
        val dark = JunoColors(
            canvas = hex(0x0e0e0e), panel = hex(0x171717), card = hex(0x212121), muted = hex(0x212121),
            composer = hex(0x212121), composerEdge = hex(0xffffff, 0.2f), composerIdle = hex(0x2f2f2f),
            selected = hex(0x3a3a3a), fg = hex(0xededed), fgMuted = hex(0xcdcdcd), fgSubtle = hex(0xafafaf),
            border = hex(0xfcfcfc, 0.15f), primary = hex(0xfafafa), primaryFg = hex(0x070707),
            bubbleAgent = hex(0x333333), bubbleAgentFg = hex(0xfcfcfc), bubbleUser = hex(0xf4efe6), bubbleUserFg = hex(0x141414),
            bgSubtle = hex(0x171717), hover = hex(0x2f2f2f), inputBg = hex(0x2f2f2f),
            requestCard = hex(0x181818), tile = hex(0x242424), isDark = true,
        )

        private fun hex(rgb: Long, alpha: Float = 1f) = Color(0xFF000000 or rgb).copy(alpha = alpha)
    }
}

/** Status colours and the Today glow are the same in both modes. */
object JunoStatus {
    val success = Color(0xFF00C972)
    val warning = Color(0xFFFF9800)
    val danger = Color(0xFFFF263C)

    /** The Today glow: soft pink, purple and blue (the characters' tints). */
    val glow = listOf(Color(0xFFF08BB4), Color(0xFF9B7BF0), Color(0xFF5B8DEF))
}
