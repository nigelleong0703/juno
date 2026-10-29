package io.github.nigelleong0703.juno.ui.theme

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.ui.components.ButtonSize
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.components.JunoTextField

/**
 * Dev-only visual QA page: every colour token in light and dark, the status colours and glow, every text style, every
 * button variant and size (enabled and disabled), and text field states. Not linked from navigation; open it from a
 * debug route or preview it in Android Studio.
 */
@Composable
fun ThemeGalleryScreen(modifier: Modifier = Modifier) {
    Column(
        modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp),
    ) {
        Text("Theme gallery (dev only)", style = junoText(TextSize.Xl, FontWeight.SemiBold), color = JunoTheme.colors.fg)
        ModeSection(dark = false)
        ModeSection(dark = true)
        SharedSection()
    }
}

@Composable
private fun ModeSection(dark: Boolean) {
    JunoTheme(dark = dark) {
        val c = JunoTheme.colors
        Column(
            Modifier
                .fillMaxWidth()
                .background(c.canvas, RoundedCornerShape(Radius.lg))
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Text(if (dark) "Dark" else "Light", style = junoText(TextSize.Lg, FontWeight.SemiBold), color = c.fg)
            Heading("Colours")
            val swatches = listOf(
                "canvas" to c.canvas, "panel" to c.panel, "card" to c.card, "muted" to c.muted,
                "composer" to c.composer, "composerEdge" to c.composerEdge, "composerIdle" to c.composerIdle,
                "selected" to c.selected, "fg" to c.fg, "fgMuted" to c.fgMuted, "fgSubtle" to c.fgSubtle,
                "border" to c.border, "primary" to c.primary, "primaryFg" to c.primaryFg,
                "bubbleAgent" to c.bubbleAgent, "bubbleAgentFg" to c.bubbleAgentFg,
                "bubbleUser" to c.bubbleUser, "bubbleUserFg" to c.bubbleUserFg,
                "bgSubtle" to c.bgSubtle, "hover" to c.hover, "inputBg" to c.inputBg,
                "requestCard" to c.requestCard, "tile" to c.tile,
            )
            swatches.forEach { (name, color) -> Swatch(name, color) }
            Heading("Text styles")
            TextStyles()
            Heading("Buttons")
            ButtonMatrix()
            Heading("Text fields")
            TextFieldStates()
        }
    }
}

@Composable
private fun SharedSection() {
    val c = JunoTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Heading("Status and glow (same in both modes)")
        Swatch("success", JunoStatus.success)
        Swatch("warning", JunoStatus.warning)
        Swatch("danger", JunoStatus.danger)
        JunoStatus.glow.forEachIndexed { i, color -> Swatch("glow ${i + 1}", color) }
        Text("Radii and avatar sizes", style = junoText(TextSize.Sm, FontWeight.Medium), color = c.fgMuted)
        Text(
            "radius xs 4 · sm 8 · md 10 · lg 14 · xl 16 · xxl 18 · composer 26 · card 28 · tile 20 · preview 16 · screen 24 · popover 14 (dp)",
            style = junoText(TextSize.Xs), color = c.fgMuted,
        )
        Text(
            "avatar author 18 · xs 20 · sm 24 · md 32 · lg 40 · header 56 · profile 90 · card 112 · chatHeader 88 (dp)",
            style = junoText(TextSize.Xs), color = c.fgMuted,
        )
    }
}

@Composable
private fun Heading(text: String) {
    Text(text, style = junoText(TextSize.Base, FontWeight.SemiBold), color = JunoTheme.colors.fgMuted)
}

@Composable
private fun Swatch(name: String, color: Color) {
    val c = JunoTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Box(
            Modifier
                .size(40.dp)
                .background(color, RoundedCornerShape(Radius.sm))
                .border(1.dp, c.border, RoundedCornerShape(Radius.sm)),
        )
        Text(name, style = junoText(TextSize.Sm), color = c.fg)
    }
}

@Composable
private fun TextStyles() {
    val c = JunoTheme.colors
    val sizes = listOf(
        TextSize.Xxs to "2xs", TextSize.Xs to "xs", TextSize.Sm to "sm", TextSize.Base to "base",
        TextSize.Md to "md", TextSize.Lg to "lg", TextSize.Xl to "xl", TextSize.Xxl to "xxl",
    )
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        sizes.forEach { (size, label) ->
            Text("$label ${size.size.toInt()}/${size.lineHeight.toInt()} regular", style = junoText(size), color = c.fg)
        }
        Text("sm 13/18 medium", style = junoText(TextSize.Sm, FontWeight.Medium), color = c.fg)
        Text("md 15/22 semibold", style = junoText(TextSize.Md, FontWeight.SemiBold), color = c.fg)
        Text("sm 13/18 muted", style = junoText(TextSize.Sm), color = c.fgMuted)
        Text("sm 13/18 subtle", style = junoText(TextSize.Sm), color = c.fgSubtle)
    }
}

@Composable
private fun ButtonMatrix() {
    val c = JunoTheme.colors
    val variants = listOf(ButtonVariant.Primary, ButtonVariant.Secondary, ButtonVariant.Ghost)
    val sizes = listOf(ButtonSize.Xs, ButtonSize.Sm, ButtonSize.Regular, ButtonSize.Large, ButtonSize.Hero)
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        variants.forEach { variant ->
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(variant.name, style = junoText(TextSize.Sm, FontWeight.Medium), color = c.fgMuted)
                sizes.forEach { size -> JunoButton(size.name, {}, variant = variant, size = size) }
                JunoButton("Disabled", {}, variant = variant, enabled = false)
            }
        }
        Text("Sizes: Xs 24 · Sm 32 · Regular 36 · Large 40 · Hero 52 (dp)", style = junoText(TextSize.Xs), color = c.fgMuted)
    }
}

@Composable
private fun TextFieldStates() {
    val c = JunoTheme.colors
    var empty by remember { mutableStateOf("") }
    var filled by remember { mutableStateOf("juno@example.com") }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        JunoTextField(empty, { empty = it }, "Email (empty)", Modifier.fillMaxWidth())
        JunoTextField(filled, { filled = it }, "Email", Modifier.fillMaxWidth())
    }
}

@Preview(showBackground = true, widthDp = 390)
@Composable
private fun ThemeGalleryPreview() {
    JunoTheme(dark = false) {
        ThemeGalleryScreen(Modifier.background(JunoTheme.colors.canvas))
    }
}
