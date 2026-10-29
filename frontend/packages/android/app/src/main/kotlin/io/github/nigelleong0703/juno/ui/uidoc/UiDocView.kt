package io.github.nigelleong0703.juno.ui.uidoc

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.FeedUiDoc
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.serialization.json.JsonElement

/**
 * What a card's interactive block does with an answer: [recorded] shows a decided question's answers in place of the
 * inputs; [errors] are the server's per-block or per-field reasons; [onAnswer] receives the answers to send.
 */
data class UiAnswering(
    val recorded: Map<String, String>? = null,
    val errors: Map<String, String> = emptyMap(),
    val busy: Boolean = false,
    val onAnswer: (Map<String, String>) -> Unit = {},
)

/**
 * Draws a UI doc (`FeedPost.ui`, chat item `ui`). A doc this app cannot draw shows its server text, never nothing.
 * Plain column: no lazy containers inside list items. [answering] enables the interactive blocks; without it they are
 * left out (the feed does not answer questions).
 */
@Composable
fun UiDocView(
    doc: JsonElement?,
    modifier: Modifier = Modifier,
    showTitle: Boolean = false,
    answering: UiAnswering? = null,
) {
    val parsed = remember(doc) { UiDocParser.parse(doc) }
    val c = JunoTheme.colors
    if (!parsed.isRenderable) {
        parsed.text?.let { Text(it, style = junoText(TextSize.Base), color = c.fg, modifier = modifier.fillMaxWidth()) }
        return
    }
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (showTitle) parsed.title?.let { Text(it, style = junoText(TextSize.Md, FontWeight.SemiBold), color = c.fg) }
        parsed.blocks.forEach { block -> UiBlockView(block, nested = false, answering = answering) }
    }
}

/** The same view for a typed chat/request doc (`FeedUiDoc`): it is drawn from its wire form, so there is one renderer. */
@Composable
fun UiDocView(
    doc: FeedUiDoc,
    modifier: Modifier = Modifier,
    showTitle: Boolean = false,
    answering: UiAnswering? = null,
) = UiDocView(remember(doc) { doc.toJson() }, modifier, showTitle, answering)

/** One block at the top level ([nested] false: display blocks sit on a tile) or inside a group. */
@Composable
internal fun UiBlockView(block: UiBlock, nested: Boolean, answering: UiAnswering?) {
    when (block) {
        is UiBlock.Text -> Text(block.text, style = junoText(TextSize.Base), color = JunoTheme.colors.fg)
        is UiBlock.Facts -> UiTile(nested) { UiFacts(block.rows) }
        is UiBlock.Items -> UiTile(nested) { UiItems(block.rows, block.total) }
        is UiBlock.Table -> UiTile(nested) { UiTable(block.columns, block.rows) }
        is UiBlock.Notice -> UiNotice(block.tone, block.text)
        is UiBlock.Link -> UiLink(block.url, block.title, block.subtitle)
        is UiBlock.Image -> UiImageBlock(block.libraryId, block.caption)
        is UiBlock.Group -> UiGroup(block)
        is UiBlock.Choices -> answering?.let { UiChoices(block, it) }
        is UiBlock.Fields -> answering?.let { UiFieldsForm(block, it) }
        is UiBlock.Replies, UiBlock.Unknown -> Unit
    }
}
