package io.github.nigelleong0703.juno.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mikepenz.markdown.compose.components.markdownComponents
import com.mikepenz.markdown.compose.elements.MarkdownCodeBlock
import com.mikepenz.markdown.compose.elements.MarkdownCodeBackground
import com.mikepenz.markdown.compose.elements.MarkdownCodeFence
import com.mikepenz.markdown.compose.elements.material.MarkdownBasicText
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography
import com.mikepenz.markdown.model.markdownAlertColors
import com.mikepenz.markdown.model.markdownDimens
import com.mikepenz.markdown.model.markdownPadding
import dev.snipme.highlights.Highlights
import dev.snipme.highlights.model.BoldHighlight
import dev.snipme.highlights.model.ColorHighlight
import dev.snipme.highlights.model.SyntaxLanguage
import dev.snipme.highlights.model.SyntaxTheme
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

private val imageSyntax = Regex("!\\[[^]]*]\\([^)]*\\)")

/** iOS code block: a rounded (8) box with a hairline border. */
private val CodeRadius = 8.dp

/**
 * Syntax colours for fenced code, close to the iPhone's (keywords purple, identifiers/members teal). RGB ints, as
 * `dev.snipme` expects; the code itself keeps the body's ink.
 */
private val codeTheme = SyntaxTheme(
    key = "juno", code = 0x1C1C1E, keyword = 0x9B2D9B, string = 0x2F7A4B, literal = 0xB35C00,
    comment = 0x8A8F98, metadata = 0x2A7F86, multilineComment = 0x8A8F98, punctuation = 0x6B7280, mark = 0x1C1C1E,
)

/**
 * Markdown body (agent messages, artifacts, Feed posts), styled as the iOS `JunoMarkdownStyle`: headings H1-H2 larger
 * and semibold, inline code on a muted tile, fenced code in a bordered canvas box with syntax colours, links in the text
 * colour with an underline. Links open through [openLink]. No remote images (the spec strips image syntax). [ink] is the
 * text colour of the surface it sits on.
 */
@Composable
fun MarkdownText(text: String, ink: Color, modifier: Modifier = Modifier, size: TextSize = TextSize.Md, stripImages: Boolean = true) {
    val context = LocalContext.current
    val border = JunoTheme.colors.border
    val linkHandler = remember(context) {
        object : UriHandler {
            override fun openUri(uri: String) { context.openLink(uri, webOnly = true) }
        }
    }
    val content = remember(text, stripImages) { if (stripImages) text.replace(imageSyntax, "") else text }
    val body = junoText(size)
    // iOS JunoMarkdownStyle: inline code sits on Theme.muted; fenced code on Theme.canvas with a hairline border.
    // The code is 0.9x (inline) / 0.882x (block) the body.
    val codeBackground = JunoTheme.colors.muted
    val canvas = JunoTheme.colors.canvas
    val heading = { scale: Float -> body.copy(fontSize = (size.size * scale).sp, lineHeight = (size.lineHeight * scale).sp, fontWeight = FontWeight.SemiBold) }
    val highlights = remember { Highlights.Builder().theme(codeTheme) }
    val codeComponents = remember(border, canvas, highlights) {
        markdownComponents(
            codeBlock = { model ->
                MarkdownCodeBlock(model.content, model.node, model.typography.code) { code, language, style ->
                    JunoCodeBox(code, language, style, highlights, canvas, border)
                }
            },
            codeFence = { model ->
                MarkdownCodeFence(model.content, model.node, model.typography.code) { code, language, style ->
                    JunoCodeBox(code, language, style, highlights, canvas, border)
                }
            },
        )
    }
    CompositionLocalProvider(LocalUriHandler provides linkHandler) {
        Markdown(
            content = content,
            colors = markdownColor(
                text = ink,
                codeBackground = canvas,
                inlineCodeBackground = codeBackground,
                dividerColor = border,
                tableBackground = Color.Transparent,
                alert = markdownAlertColors(note = ink, tip = ink, important = ink, warning = ink, caution = ink),
            ),
            typography = markdownTypography(
                h1 = heading(1.3f),
                h2 = heading(1.15f),
                h3 = heading(1f),
                h4 = heading(1f),
                h5 = heading(1f),
                h6 = heading(1f),
                text = body,
                paragraph = body,
                quote = body,
                ordered = body,
                bullet = body,
                list = body,
                code = body.copy(fontSize = (size.size * 0.882f).sp, fontFamily = FontFamily.Monospace),
                inlineCode = body.copy(fontSize = (size.size * 0.9f).sp, fontFamily = FontFamily.Monospace),
                textLink = TextLinkStyles(SpanStyle(textDecoration = TextDecoration.Underline)),
                table = body,
            ),
            // iOS blockSpacing is about 0.9 em between paragraphs and none at the edges; the bubble's own 7dp
            // vertical padding (less this 6dp) gives the same edge gap, so a one-line bubble is 36dp tall as on iPhone.
            padding = markdownPadding(block = 6.dp),
            dimens = markdownDimens(codeBackgroundCornerSize = CodeRadius),
            components = codeComponents,
            modifier = modifier,
        )
    }
}

/**
 * One fenced code block: the renderer's own code background with the hairline border, the text highlighted by
 * `dev.snipme` (the code module's engine). Scrolls sideways like the renderer's block.
 */
@Composable
private fun JunoCodeBox(
    code: String,
    language: String?,
    style: TextStyle,
    highlights: Highlights.Builder,
    canvas: Color,
    border: Color,
) {
    val text = remember(code, language, highlights) { highlight(code, language, highlights) }
    MarkdownCodeBackground(
        color = canvas,
        shape = RoundedCornerShape(CodeRadius),
        border = BorderStroke(0.5.dp, border),
        modifier = Modifier.padding(vertical = 8.dp),
        language = language,
        code = code,
    ) {
        MarkdownBasicText(
            text = text,
            style = style,
            modifier = Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 10.dp),
        )
    }
}

private fun highlight(code: String, language: String?, builder: Highlights.Builder): AnnotatedString {
    val syntax = language?.let { SyntaxLanguage.getByName(it) }
    val found = builder.code(code).let { if (syntax != null) it.language(syntax) else it }.build().getHighlights()
    return buildAnnotatedString {
        append(code)
        found.forEach {
            when (it) {
                is ColorHighlight -> addStyle(SpanStyle(color = Color(it.rgb).copy(alpha = 1f)), it.location.start, it.location.end)
                is BoldHighlight -> addStyle(SpanStyle(fontWeight = FontWeight.Bold), it.location.start, it.location.end)
            }
        }
    }
}
