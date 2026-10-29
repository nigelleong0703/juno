@file:OptIn(ExperimentalMaterial3Api::class)

package io.github.nigelleong0703.juno.ui.settings.models

import androidx.compose.material3.ExperimentalMaterial3Api
import io.github.nigelleong0703.juno.ui.components.JunoTextField

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.state.ChatGptLogin
import io.github.nigelleong0703.juno.ui.components.openSignInPage
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.settings.SettingsError
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.launch

/**
 * ChatGPT sign-in (iOS ChatGPTSignInView, ModelSettings.swift:414-494). Step 1 opens the sign-in page. Step 2 takes the
 * address from the browser bar: the last redirect goes to 127.0.0.1:1455, which cannot load on a phone, so the user copies
 * the address instead. A spent login starts a fresh one and says why.
 */
@Composable
fun ChatGptSignInSheet(vm: ModelsViewModel, onDismiss: () -> Unit) {
    val c = JunoTheme.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var login by remember { mutableStateOf<ChatGptLogin?>(null) }
    var pasted by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    fun start() {
        busy = true; error = null
        scope.launch {
            val (fresh, failure) = vm.startChatGpt()
            busy = false
            login = fresh
            if (fresh != null) context.openSignInPage(fresh.authorizationUrl)
            error = failure
        }
    }

    fun connect() {
        val current = login ?: return
        busy = true; error = null
        scope.launch {
            val (failure, spent) = vm.completeChatGpt(current.loginId, pasted.trim())
            busy = false
            when {
                failure == null -> onDismiss()
                spent != null -> {
                    // The login is used up: clear the paste and start over, showing the reason.
                    pasted = ""
                    login = null
                    error = spent
                }
                else -> error = failure
            }
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = c.card) {
        Column(Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
            SheetTitle("Sign in with ChatGPT")
            val current = login
            if (current == null) {
                Text(
                    "Sign in on the page that opens, then come back here. The link is valid for 10 minutes.",
                    style = junoText(TextSize.Base), color = c.fgMuted, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
                )
                JunoButton(if (busy) "Please wait…" else "Open sign-in page", ::start, Modifier.padding(horizontal = 20.dp), enabled = !busy)
            } else {
                Text(
                    "Paste the address from the browser's address bar, after you sign in. The page at 127.0.0.1:1455 will not load, which is expected.",
                    style = junoText(TextSize.Base), color = c.fgMuted, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
                )
                JunoTextField(pasted, { pasted = it }, "Address from the browser", Modifier.fillMaxWidth().padding(horizontal = 20.dp))
                JunoButton(
                    if (busy) "Connecting…" else "Connect", ::connect,
                    Modifier.padding(horizontal = 20.dp).padding(top = 8.dp), enabled = pasted.isNotBlank() && !busy,
                )
            }
            error?.let { SettingsError(it) }
        }
    }
}
