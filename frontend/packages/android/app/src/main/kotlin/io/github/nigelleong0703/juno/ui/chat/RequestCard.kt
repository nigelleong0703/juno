package io.github.nigelleong0703.juno.ui.chat

import io.github.nigelleong0703.juno.ui.components.JunoIcons
import io.github.nigelleong0703.juno.ui.uidoc.parsed
import io.github.nigelleong0703.juno.ui.uidoc.UiAnswers
import io.github.nigelleong0703.juno.ui.uidoc.UiAnswering
import io.github.nigelleong0703.juno.ui.uidoc.UiDocView
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.contract.Request
import io.github.nigelleong0703.juno.nav.Route
import io.github.nigelleong0703.juno.core.ApiException
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.open
import io.github.nigelleong0703.juno.state.answerQuestion
import io.github.nigelleong0703.juno.state.resolve
import io.github.nigelleong0703.juno.state.libraryBytes
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** The request card in the transcript and the queue: pending = the card for its flavour, decided = a slim row (iOS `RequestCard`). */
@Composable
fun RequestCard(request: Request, agentName: String?, quiet: Boolean, modifier: Modifier = Modifier, compact: Boolean = false) {
    Box(modifier.fillMaxWidth()) {
        if (request.status == "pending") PendingRequestCard(request, agentName, quiet, compact) else ResolvedRequestRow(request, agentName)
    }
}

fun requestIcon(r: Request): ImageVector = when (r.flavor()) {
    Flavor.Decision -> DecisionWords.icon(r.payload?.brief?.primary)
    Flavor.Checkout -> JunoIcons.ShoppingCart; Flavor.Send -> JunoIcons.Mail; Flavor.Command -> JunoIcons.ShieldAlert
    Flavor.Question -> JunoIcons.Help; Flavor.Secure -> JunoIcons.Lock; Flavor.Takeover -> JunoIcons.Tv
    Flavor.Signin -> JunoIcons.Key; Flavor.Connect -> JunoIcons.Link; Flavor.Generic -> JunoIcons.Hand
}

@Composable
private fun PendingRequestCard(request: Request, agentName: String?, quiet: Boolean, compact: Boolean) {
    val world = LocalWorld.current
    val name = agentName ?: "Your agent"
    val p = request.payload
    val c = JunoTheme.colors
    fun decide(d: String, edited: String? = null) = world.resolve(request.id, d, editedDraft = edited)
    val deny = { decide("denied") }
    when (request.flavor()) {
        Flavor.Decision -> DecisionCard(request, name, compact)
        Flavor.Checkout -> RequestCardShell(
            JunoIcons.ShoppingCart, "Checkout · $name wants to place an order at ${p?.purchase?.merchant ?: p?.site ?: "the merchant"}",
            "Verify the details and terms of your order on the merchant website carefully before approving.",
            content = { CheckoutDetails(request, compact) },
            actions = { CardButtons("Deny", "Allow", deny, { decide("approved") }) },
            notice = p?.notice,
        )
        Flavor.Send -> SendCard(request, name)
        Flavor.Command -> RequestCardShell(
            JunoIcons.ShieldAlert, "Run command · $name wants to run a command on its computer", p?.why ?: request.summary,
            content = { CardTile(p?.target.orEmpty(), mono = true) { Icon(JunoIcons.Terminal) } },
            actions = { CardButtons("Deny", "Run once", deny, { decide("approved") }) },
            notice = p?.notice,
        )
        Flavor.Generic -> RequestCardShell(
            JunoIcons.Hand, "Approval · $name wants to ${request.actionWords()}", p?.why ?: request.summary,
            content = { (p?.target ?: p?.site ?: p?.app)?.takeIf { it.isNotEmpty() }?.let { CardTile(it, mono = true) } },
            actions = { CardButtons("Deny", "Allow", deny, { decide("approved") }) },
            notice = p?.notice,
        )
        Flavor.Question -> QuestionCard(request, name, quiet = quiet)
        Flavor.Secure -> {
            val fields = p?.fields.orEmpty()
            val site = p?.site ?: p?.url?.substringAfter("://", "")?.substringBefore('/')?.ifEmpty { null }
            RequestCardShell(
                JunoIcons.Lock, "Secure input · $name needs your ${request.secretNoun()}", p?.reason ?: request.summary,
                content = {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.Top) {
                        androidx.compose.material3.Icon(JunoIcons.Lock, null, tint = c.fgSubtle, modifier = Modifier.padding(top = 1.dp).size(12.dp))
                        Text("End-to-end encrypted — only your computer can read this.", color = c.fgMuted, style = junoText(TextSize.Xs))
                    }
                    CardTile(
                        fields.firstOrNull()?.label ?: request.secretNoun().replaceFirstChar { it.uppercase() },
                        subtitle = listOfNotNull(if (fields.size > 1) "${fields.size} fields" else null, site?.let { "for $it" }).joinToString(" · "),
                    ) { TileBadge(JunoIcons.Lock) }
                },
                actions = { CardButtons("Cancel", "Enter securely", deny, { world.open(Route.SecureInput(request.id)) }) },
            )
        }
        Flavor.Takeover -> RequestCardShell(
            JunoIcons.Tv, "Take over · $name needs your help on its computer", p?.reason ?: request.summary,
            actions = { CardButtons("Skip", "Take over", deny, { request.agentId?.let { world.open(Route.Takeover(it, request.id)) } }, primaryEnabled = request.agentId != null) },
        )
        Flavor.Signin -> RequestCardShell(
            JunoIcons.Key, "Sign in · $name needs you to sign in${p?.site?.let { " to $it" }.orEmpty()}", p?.reason ?: request.summary,
            actions = { CardButtons("Deny", "Open sign-in", deny, { decide("approved") }) },
        )
        // Without a routine the agent only offers apps: a light list with a Connect pill each, nothing to decide.
        Flavor.Connect -> if (p?.routineId.isNullOrEmpty()) ConnectOffer(request.title ?: "Connect apps", p?.appIds.orEmpty()) else RequestCardShell(
            JunoIcons.Link, "Connect · $name needs ${p.label ?: "an app"} to run a routine", "It stays paused until one of these is connected.",
            content = { ConnectRoutineApps(p.appIds.orEmpty()) },
            actions = { JunoButton("Not now", deny, Modifier.fillMaxWidth(), io.github.nigelleong0703.juno.ui.components.ButtonVariant.Secondary) },
        )
    }
}

@Composable
private fun Icon(icon: ImageVector) = androidx.compose.material3.Icon(icon, null, tint = JunoTheme.colors.fgMuted, modifier = Modifier.padding(2.dp))

@Composable
private fun SendCard(request: Request, name: String) {
    val world = LocalWorld.current
    val p = request.payload
    val recipient = p?.recipient ?: p?.target
    val verb = if ((p?.action ?: "").lowercase().contains("mail")) "email" else "message"
    val original = p?.draft?.body.orEmpty()
    var text by remember(original) { mutableStateOf(original) }
    var editing by remember { mutableStateOf(false) }
    RequestCardShell(
        JunoIcons.Mail, "Send · $name wants to ${recipient?.let { "$verb $it" } ?: "send a message"}", p?.why ?: "Review the message before it goes out.",
        content = {
            if (recipient != null) CardTile(recipient, subtitle = p?.target?.takeIf { it != recipient }) { TileBadge(initials = ChatFormat.initials(recipient)) }
            val draft = p?.draft
            if (draft != null) CardTextBlock(draft.subject, text) { CardChip("Edit", icon = JunoIcons.Edit, onClick = { editing = true }) }
            else if (p?.target != null && recipient == null) CardTextBlock(null, p.target.orEmpty())
        },
        actions = { CardButtons("Deny", "Send", { world.resolve(request.id, "denied") }, { world.resolve(request.id, "approved", editedDraft = text.takeIf { it.isNotEmpty() && it != original }) }) },
        notice = p?.notice,
    )
    if (editing) DraftEditSheet(text, name, { editing = false }) { text = it; editing = false }
}

/** The send card's message editor: a sheet, so typing never happens inside the transcript. */
@Composable
fun DraftEditSheet(initial: String, title: String, onDismiss: () -> Unit, onDone: (String) -> Unit) {
    val c = JunoTheme.colors
    var draft by remember { mutableStateOf(initial) }
    ChatSheet(onDismiss, title, "Edit the message before it is sent.") {
        TextField(
            draft, { draft = it }, minLines = 6, maxLines = 20, shape = RoundedCornerShape(Radius.lg), modifier = Modifier.fillMaxWidth(),
            colors = TextFieldDefaults.colors(focusedContainerColor = c.inputBg, unfocusedContainerColor = c.inputBg, focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent),
        )
        JunoButton("Done", { onDone(draft) }, Modifier.fillMaxWidth(), enabled = draft.isNotBlank())
    }
}

@Composable
private fun QuestionCard(request: Request, name: String, quiet: Boolean) {
    val world = LocalWorld.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var errors by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    val doc = request.payload?.ui
    RequestCardShell(
        JunoIcons.Help, (if (quiet) "" else "Question · ") + (doc?.title ?: request.title ?: name), null,
        content = {
            if (doc != null) UiDocView(doc, answering = UiAnswering(null, errors, busy) { answers ->
                busy = true; errors = emptyMap()
                scope.launch {
                    try { world.answerQuestion(request.id, answers) }
                    catch (e: ApiException.Fields) { errors = e.errors }
                    catch (e: Throwable) { if (!e.isCancellation) errors = mapOf((UiAnswers.interactiveId(doc.parsed()) ?: "") to "Could not send. Try again.") }
                    busy = false
                }
            })
        },
    )
}

/** What an order is: the page screenshot and the server's document, else the items, card and total (iOS `CheckoutDetails`). */
@Composable
fun CheckoutDetails(request: Request, compact: Boolean) {
    val world = LocalWorld.current
    val c = JunoTheme.colors
    val p = request.payload
    val purchase = p?.purchase
    var viewing by remember { mutableStateOf(false) }
    val libraryId = p?.preview?.libraryId
    val shot by produceState<ByteArray?>(null, libraryId) { value = libraryId?.let { id -> runCatching { withContext(Dispatchers.IO) { world.libraryBytes(id) }.data }.getOrNull() } }
    val doc = p?.ui?.takeIf { !it.blocks.isNullOrEmpty() }
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        if (!compact && doc == null && libraryId != null) {
            Box(Modifier.fillMaxWidth().height(180.dp).clip(RoundedCornerShape(Radius.preview)).background(c.tile), contentAlignment = Alignment.TopCenter) {
                shot?.let { InlineImage(it, "library:$libraryId", 180.dp) } ?: androidx.compose.material3.Icon(JunoIcons.Photo, null, tint = c.fgSubtle, modifier = Modifier.align(Alignment.Center))
                shot?.let { CardChip("Review order", Modifier.align(Alignment.BottomEnd).padding(10.dp), onClick = { viewing = true }) }
            }
            if (viewing) shot?.let { ImageViewer(it) { viewing = false } }
        }
        if (doc != null) UiDocView(doc)
        else {
            purchase?.items.orEmpty().forEach { CardRow(listOfNotNull(it.quantity?.let { q -> "$q ×" }, it.name).joinToString(" "), it.price.orEmpty()) }
            purchase?.paymentMethod?.takeIf { it.isNotEmpty() }?.let { CardTile(it, subtitle = "Saved card") { TileBadge(JunoIcons.CreditCard) } }
            purchase?.total?.takeIf { it.isNotEmpty() }?.let { CardRow("Estimated total", it) }
        }
    }
}
