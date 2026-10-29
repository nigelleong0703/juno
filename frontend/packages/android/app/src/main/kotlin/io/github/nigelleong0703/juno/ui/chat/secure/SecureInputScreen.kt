package io.github.nigelleong0703.juno.ui.chat.secure

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import io.github.nigelleong0703.juno.core.BiometricVaultGate
import io.github.nigelleong0703.juno.core.KeystoreVaultKeys
import io.github.nigelleong0703.juno.core.SecureVault
import io.github.nigelleong0703.juno.core.VaultAccessGate
import io.github.nigelleong0703.juno.core.findFragmentActivity
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.state.returnControl
import io.github.nigelleong0703.juno.ui.chat.secretNoun
import io.github.nigelleong0703.juno.ui.components.ButtonSize
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.components.JunoSheet
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File

/**
 * The form for a `secure_input` request (iOS `SecureInputSheet`): the values a page asks for are sealed on this phone to the
 * computer's key, and go to the page through the server. Values live only in [SecureFormState] and are cleared when the
 * sheet closes, which happens only after the server took them. The sheet is the route's page: it opens over the chat, and
 * closing it pops the route.
 */
@Composable
fun SecureInputScreen(requestId: String, onBack: () -> Unit) {
    val world = LocalWorld.current
    val state by world.state.collectAsState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    // The prompt needs the hosting activity; without one, a locked key simply refuses (fails closed).
    val vault = remember(context) {
        val activity = context.findFragmentActivity()
        val gate = activity?.let { BiometricVaultGate(it) } ?: VaultAccessGate { false }
        SecureVault(File(context.filesDir, SecureVault.FILE_NAME), KeystoreVaultKeys(context), gate)
    }
    val form = remember(requestId) { SecureFormState(vaultLocked = vault.isLocked) }
    DisposableEffect(requestId) { onDispose { form.clear() } }

    val request = state.request(requestId)
    val payload = request?.payload
    val fields = payload?.fields.orEmpty()
    val name = state.agent(request?.agentId)?.name ?: "Your agent"
    val site = payload?.site
    val c = JunoTheme.colors

    // Prefill is a convenience: a vault that cannot be read leaves the fields empty rather than failing the sheet.
    LaunchedEffect(requestId) {
        try {
            form.prefillFromVault(world, vault, fields)
        } catch (e: Throwable) {
            if (e.isCancellation) throw e
        }
    }

    fun submit() {
        if (form.busy) return
        scope.launch {
            if (form.send(world, vault, requestId, fields, payload?.encryption, site)) onBack()
        }
    }

    val title = when {
        fields.size == 1 -> fields[0].label ?: "Secure input"
        request?.secretNoun() == "card details" -> "Card details"
        else -> "Secure input"
    }
    JunoSheet(
        title = title,
        onDismiss = onBack,
        primary = if (form.busy) "Sending…" else "Submit",
        primaryEnabled = form.isReady(fields, site),
        loading = form.busy,
        onPrimary = ::submit,
    ) {
        (payload?.reason ?: request?.summary)?.takeIf { it.isNotEmpty() }?.let {
            Text(it, color = c.fgMuted, style = junoText(TextSize.Sm))
        }
        Text("End-to-end encrypted — only your computer can read this.", color = c.fgMuted, style = junoText(TextSize.Xs))
        form.message?.let { message ->
            Text(message, color = JunoStatus.danger, style = junoText(TextSize.Sm))
            val agentId = request?.agentId
            if (form.needsHandBack && agentId != null) {
                JunoButton(
                    "Return the screen to $name",
                    onClick = {
                        scope.launch {
                            // The hand-back takes a moment on the computer; then the held values go again.
                            world.returnControl(agentId)
                            delay(900)
                            if (form.held != null && form.send(world, vault, requestId, fields, payload?.encryption, site)) onBack()
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                    variant = ButtonVariant.Secondary,
                    size = ButtonSize.Large,
                )
            }
        }
        fields.forEach { field -> SecureFieldRow(field, form, site, enabled = !form.busy) }
    }
}
