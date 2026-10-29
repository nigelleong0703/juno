package io.github.nigelleong0703.juno.ui.chat

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.animation.animateContentSize
import io.github.nigelleong0703.juno.ui.uidoc.parsed
import io.github.nigelleong0703.juno.ui.uidoc.UiAnswers
import io.github.nigelleong0703.juno.ui.uidoc.UiAnswering
import io.github.nigelleong0703.juno.ui.uidoc.UiDocView
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Request
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** What a decided row says: the outcome tone, its title and the subject after the dot (iOS `ResolvedRequestRow.label`). */
data class ResolvedLabel(val tone: DecisionWords.Tone, val title: String, val subtitle: String?)

fun resolvedLabel(r: Request): ResolvedLabel {
    val p = r.payload
    val d = r.decision
    // The agent withdrew its own request in chat: show the user's words, not an outcome.
    if (d?.reason == "cancelled" && d.by != null && d.by == r.agentId && !d.note.isNullOrEmpty()) return ResolvedLabel(DecisionWords.Tone.Neutral, "Withdrawn in chat: ${d.note}", null)
    val flavor = r.flavor()
    val ok = r.status == "approved" || r.status == "answered"
    val tone = if (ok) DecisionWords.Tone.Done else if (r.status == "denied" && flavor != Flavor.Connect) DecisionWords.Tone.Refused else DecisionWords.Tone.Neutral
    if (flavor in setOf(Flavor.Decision, Flavor.Checkout, Flavor.Send, Flavor.Command, Flavor.Generic)) {
        DecisionWords.outcome(r.outcome)?.let { return ResolvedLabel(DecisionWords.tone(r.outcome), it, ChatFormat.sentence(r)) }
    }
    val (status, subject) = when (flavor) {
        Flavor.Decision -> (if (ok) "Allowed" else "Denied") to ChatFormat.sentence(r)
        Flavor.Checkout -> (if (ok) "Allowed" else "Denied") to "Order at ${p?.purchase?.merchant ?: p?.site ?: "the merchant"}"
        Flavor.Send -> (if (ok) "Sent" else "Denied") to (p?.recipient?.let { "To $it" } ?: p?.draft?.subject)
        Flavor.Command -> (if (ok) "Ran once" else "Denied") to p?.target
        Flavor.Question -> (if (ok) "Answered" else "Skipped") to listOfNotNull(p?.ui?.let(::headline), p?.ui?.let { UiAnswers.summary(it.parsed(), p.answers) }).filter { it.isNotEmpty() }.joinToString(" · ")
        Flavor.Secure -> (if (ok) "Entered securely" else "Cancelled") to (p?.fields?.firstOrNull()?.label ?: r.secretNoun())
        Flavor.Takeover -> (if (ok) "Handed back" else "Skipped") to (p?.reason ?: "Take over")
        Flavor.Signin -> (if (ok) "Signed in" else "Denied") to p?.site
        Flavor.Connect -> (if (ok) "Connected" else "Not now") to p?.label
        Flavor.Generic -> (if (ok) "Allowed" else "Denied") to r.actionWords().replaceFirstChar { it.uppercase() }
    }
    return ResolvedLabel(tone, if (r.status == "expired") "Expired" else status, subject)
}

/** The question's headline: its title, else the first line of its text (iOS `UiDoc.headline`). */
private fun headline(doc: io.github.nigelleong0703.juno.contract.FeedUiDoc): String? =
    doc.title?.takeIf { it.isNotEmpty() } ?: doc.text?.lineSequence()?.firstOrNull()

/**
 * A decided request: one slim row, tap expands what, why, the answers and when (iOS `ResolvedCardRow`): a 28pt tone
 * circle, the title semibold with the subject muted after " · ", one line until open, and a chevron that turns down.
 */
@Composable
fun ResolvedRequestRow(request: Request, agentName: String?) {
    val c = JunoTheme.colors
    val label = resolvedLabel(request)
    var open by remember { mutableStateOf(false) }
    DecidedSurface(Modifier.animateContentSize().clickable { open = !open }) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            val (bg, icon) = when (label.tone) {
                DecisionWords.Tone.Done -> JunoStatus.success to JunoIcons.Check
                DecisionWords.Tone.Refused -> JunoStatus.danger to JunoIcons.Close
                DecisionWords.Tone.Neutral -> c.fgSubtle to JunoIcons.Minus
            }
            Box(Modifier.size(28.dp).clip(CircleShape).background(bg), contentAlignment = Alignment.Center) {
                Icon(icon, null, tint = androidx.compose.ui.graphics.Color.White, modifier = Modifier.size(15.dp))
            }
            Text(
                buildAnnotatedString {
                    withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(label.title) }
                    label.subtitle?.takeIf { it.isNotEmpty() }?.let { subject -> withStyle(SpanStyle(color = c.fgMuted)) { append(" · $subject") } }
                },
                color = c.fg, style = junoText(TextSize.Base), maxLines = if (open) Int.MAX_VALUE else 1,
                overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
            )
            Icon(JunoIcons.ChevronRight, null, tint = c.fgSubtle, modifier = Modifier.size(16.dp).rotate(if (open) 90f else 0f))
        }
        if (open) RequestFacts(request, agentName)
    }
}

/** The details under an expanded decided row. */
@Composable
private fun RequestFacts(request: Request, agentName: String?) {
    val c = JunoTheme.colors
    val p = request.payload
    Column(Modifier.padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (request.flavor() == Flavor.Question) p?.ui?.let { UiDocView(it, answering = UiAnswering(recorded = p.answers.orEmpty())) }
        if (p?.purchase != null) CheckoutDetails(request, compact = false)
        p?.target?.takeIf { request.flavor() == Flavor.Command || request.flavor() == Flavor.Generic }?.let {
            Text(it, color = c.fg, style = junoText(TextSize.Sm).copy(fontFamily = FontFamily.Monospace))
        }
        p?.draft?.body?.let { Text(it, color = c.fgMuted, style = junoText(TextSize.Base)) }
        (p?.brief?.why ?: p?.why ?: p?.reason ?: request.summary.takeIf { request.flavor() != Flavor.Question })?.let { Text(it, color = c.fgMuted, style = junoText(TextSize.Base)) }
        p?.brief?.ifDenied?.takeIf { it.isNotEmpty() }?.let { Text("If you said no: $it", color = c.fgSubtle, style = junoText(TextSize.Sm)) }
        Text(listOfNotNull(agentName, request.resolvedAt?.let { ChatFormat.ago(it) }).joinToString(" · "), color = c.fgSubtle, style = junoText(TextSize.Sm))
    }
}
