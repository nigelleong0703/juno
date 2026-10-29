package io.github.nigelleong0703.juno.ui.chat

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import io.github.nigelleong0703.juno.ui.components.ButtonSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Request
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.resolve
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/**
 * The card for a decision beyond the agent's authority (iOS `DecisionCard`): who is asking, the one-sentence ask, what it
 * costs or risks, what you would see, and the answers Deny / Allow once / Allow this kind... / Change it...
 * The platform picture is the category icon (brand and site icons are not fetched on Android yet).
 */
@Composable
fun DecisionCard(request: Request, name: String, compact: Boolean) {
    val world = LocalWorld.current
    val c = JunoTheme.colors
    val p = request.payload
    val brief = p?.brief
    val draft = p?.draft
    val original = draft?.body.orEmpty()
    var text by remember(original) { mutableStateOf(original) }
    var editing by remember { mutableStateOf(false) }
    var delegating by remember { mutableStateOf(false) }
    var revising by remember { mutableStateOf(false) }
    var allTargets by remember { mutableStateOf(false) }
    val edited = text.takeIf { it.isNotEmpty() && it != original }

    CardSurface {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                if (p?.macApp != null) AppGlyph() else PlatformIcon(brief)
                Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Text(brief?.platform?.name ?: name, color = c.fg, style = junoText(TextSize.Sm, FontWeight.Medium), maxLines = 1)
                    Text("$name is asking", color = c.fgSubtle, style = junoText(TextSize.Xs), maxLines = 1)
                }
            }
            Text(ChatFormat.sentence(request), color = c.fg, style = junoText(TextSize.Md, FontWeight.SemiBold))
            p?.notice?.takeIf { it.isNotEmpty() }?.let { Text(it, color = c.fgSubtle, style = junoText(TextSize.Xs)) }
            val badges = DecisionWords.badges(brief)
            if (badges.isNotEmpty()) Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                badges.forEach { CategoryBadge(DecisionWords.badge(it), DecisionWords.icon(it), warn = it == "irreversible" || it == "sensitive") }
            }
        }
        brief?.consequences().orEmpty().takeIf { it.isNotEmpty() }?.let { rows ->
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.tile)).background(c.tile).padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                rows.forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(row.icon, null, tint = if (row.declared) c.fgSubtle else c.fg, modifier = Modifier.size(18.dp))
                        Text(row.text, color = if (row.declared) c.fgMuted else c.fg, style = junoText(TextSize.Base, FontWeight.Medium), modifier = Modifier.weight(1f, fill = false))
                        if (row.declared) Text("agent says", color = c.fgSubtle, style = junoText(TextSize.Xs))
                    }
                }
            }
        }
        if (p?.purchase != null || !p?.ui?.blocks.isNullOrEmpty()) CheckoutDetails(request, compact)
        if (draft != null) CardTextBlock(draft.subject, text) { CardChip("Edit", icon = JunoIcons.Edit, onClick = { editing = true }) }
        else if (brief?.primary == "setup" && !p?.target.isNullOrEmpty()) CardTile(p?.target.orEmpty(), mono = true) { Icon(JunoIcons.Terminal, null, tint = c.fgMuted) }
        brief?.facts?.targets?.takeIf { it.isNotEmpty() }?.let { targets ->
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.tile)).background(c.tile).padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                targets.take(if (allTargets) targets.size else 5).forEach { CardRow(it.label.orEmpty(), it.count?.let { n -> "×$n" }.orEmpty()) }
                if (targets.size > 5) Text(if (allTargets) "Show less" else "Show all ${targets.size}", color = c.fg, style = junoText(TextSize.Sm, FontWeight.Medium), modifier = Modifier.clickable { allTargets = !allTargets })
            }
        }
        (brief?.why ?: p?.why)?.takeIf { it.isNotEmpty() }?.let { ExpandableText(it, lines = 3) }
        brief?.ifDenied?.takeIf { it.isNotEmpty() }?.let { Text("If you say no: $it", color = c.fgSubtle, style = junoText(TextSize.Sm)) }

        val macApp = p?.macApp
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (macApp != null) {
                // An app on the owner's Mac: Allow once / Always allow (kept per app) / Don't allow. Bringing it to the front is one tap, never remembered.
                val foreground = macApp.purpose == "foreground"
                CardButtons("Don't allow", if (foreground) "Allow" else "Allow once", { world.resolve(request.id, "denied") }, { world.resolve(request.id, "approved") })
                if (!foreground) JunoButton("Always allow", { world.resolve(request.id, "approved", scope = "app") }, Modifier.fillMaxWidth(), ButtonVariant.Secondary, size = ButtonSize.Regular)
            } else {
                CardButtons("Deny", "Allow once", { world.resolve(request.id, "denied") }, { world.resolve(request.id, "approved", editedDraft = edited) })
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (p?.delegationOffer?.delegable == true) JunoButton("Allow this kind…", { delegating = true }, Modifier.weight(1f), ButtonVariant.Secondary, size = ButtonSize.Regular)
                    JunoButton("Change it…", { revising = true }, Modifier.weight(1f), ButtonVariant.Secondary, size = ButtonSize.Regular)
                }
            }
        }
    }
    if (editing) DraftEditSheet(text, name, { editing = false }) { text = it; editing = false }
    if (delegating) ChatSheet({ delegating = false }, "Allow this kind", "$name will not ask again for this kind of request, within the limits you can review in Permissions.") {
        Text(ChatFormat.sentence(request), color = c.fg, style = junoText(TextSize.Base, FontWeight.Medium))
        JunoButton("Allow this kind", {
            world.resolve(request.id, "approved", editedDraft = edited, delegations = p?.delegationOffer?.suggested.orEmpty())
            delegating = false
        }, Modifier.fillMaxWidth())
    }
    if (revising) ReviseSheet(name, { revising = false }) { note ->
        world.resolve(request.id, "denied", note = note, reason = "revise")
        revising = false
    }
}

/** "Change it…": sends the request back to the agent with a note on what should change. */
@Composable
private fun ReviseSheet(name: String, onDismiss: () -> Unit, onSend: (String) -> Unit) {
    val c = JunoTheme.colors
    var note by remember { mutableStateOf("") }
    ChatSheet(onDismiss, "Change it", "Tell $name what to do differently. It will come back with a new ask.") {
        TextField(
            note, { note = it }, minLines = 3, maxLines = 8, placeholder = { Text("What should change?") }, shape = RoundedCornerShape(Radius.lg), modifier = Modifier.fillMaxWidth(),
            colors = TextFieldDefaults.colors(focusedContainerColor = c.inputBg, unfocusedContainerColor = c.inputBg, focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent),
        )
        JunoButton("Send back", { onSend(note.trim()) }, Modifier.fillMaxWidth(), enabled = note.isNotBlank())
    }
}
