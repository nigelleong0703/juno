package io.github.nigelleong0703.juno.ui.screens

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.nigelleong0703.juno.BuildConfig
import io.github.nigelleong0703.juno.core.ApiException
import io.github.nigelleong0703.juno.core.isCancellation
import io.github.nigelleong0703.juno.core.userMessage
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.ButtonSize
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.components.JunoMark
import io.github.nigelleong0703.juno.ui.components.JunoTextField
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText
import kotlinx.coroutines.launch

private enum class AuthMode { SignIn, Register }

/**
 * Sign in / Create account (iOS Features/Onboarding/Login.swift; the first-run onboarding carousel is not ported).
 * Welcome with two buttons, then the credentials form; the server address is tucked under "Server".
 */
@Composable
fun SignInScreen() {
    var mode by rememberSaveable { mutableStateOf<AuthMode?>(null) }
    Column(
        Modifier.fillMaxSize().background(JunoTheme.colors.canvas).systemBarsPadding().imePadding()
            .verticalScroll(rememberScrollState()).padding(horizontal = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        val current = mode
        if (current == null) Welcome(onChoose = { mode = it })
        else CredentialsForm(current, onModeChange = { mode = it }, onBack = { mode = null })
    }
}

@Composable
private fun Welcome(onChoose: (AuthMode) -> Unit) {
    val c = JunoTheme.colors
    Spacer(Modifier.height(48.dp))
    JunoMark(110.dp)
    Text("Juno", style = junoText(TextSize.Xxl, FontWeight.Bold).copy(fontSize = 44.sp), color = c.fg)
    Text(
        "A team of agents, each with a computer of their own.", style = junoText(TextSize.Lg), color = c.fgMuted,
        textAlign = TextAlign.Center, modifier = Modifier.padding(top = 10.dp),
    )
    Spacer(Modifier.height(96.dp))
    JunoButton("Log in", { onChoose(AuthMode.SignIn) }, Modifier.fillMaxWidth(), size = ButtonSize.Hero)
    Spacer(Modifier.height(12.dp))
    JunoButton("Create account", { onChoose(AuthMode.Register) }, Modifier.fillMaxWidth(), ButtonVariant.Secondary, ButtonSize.Hero)
}

@Composable
private fun CredentialsForm(mode: AuthMode, onModeChange: (AuthMode) -> Unit, onBack: () -> Unit) {
    val c = JunoTheme.colors
    val world = LocalWorld.current
    val scope = rememberCoroutineScope()
    val register = mode == AuthMode.Register
    var name by rememberSaveable { mutableStateOf("") }
    var email by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var server by rememberSaveable { mutableStateOf(BuildConfig.JUNO_SERVER_URL) }
    var serverOpen by rememberSaveable { mutableStateOf(false) }
    var showPassword by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val ready = email.isNotEmpty() && password.length >= (if (register) 8 else 1) && (!register || name.isNotEmpty())

    fun submit() {
        if (!ready || busy) return
        val url = server.trim()
        if (!(url.startsWith("http://") || url.startsWith("https://"))) { error = ApiException.BadServer.message; serverOpen = true; return }
        busy = true; error = null
        scope.launch {
            try {
                if (register) world.signUp(url, name, email.trim(), password) else world.signIn(url, email.trim(), password)
            } catch (e: Throwable) {
                if (!e.isCancellation) { password = ""; error = e.userMessage }
            } finally { busy = false }
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(10.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(
            if (register) "Create your account" else "Welcome back", color = c.fg,
            style = junoText(TextSize.Xxl, FontWeight.Bold),
        )
        Text(
            if (register) "Your agents and chats belong to your account." else "Log in to see what your agents are doing.",
            style = junoText(TextSize.Base), color = c.fgMuted, textAlign = TextAlign.Center, modifier = Modifier.padding(bottom = 6.dp),
        )
        if (register) JunoTextField(name, { name = it }, "Name", Modifier.fillMaxWidth())
        JunoTextField(email, { email = it }, "Email", Modifier.fillMaxWidth(), KeyboardOptions(keyboardType = KeyboardType.Email))
        JunoTextField(
            password, { password = it }, "Password", Modifier.fillMaxWidth(), KeyboardOptions(keyboardType = KeyboardType.Password),
            if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
            trailingIcon = {
                IconButton({ showPassword = !showPassword }) {
                    Icon(if (showPassword) JunoIcons.EyeOff else JunoIcons.Eye, if (showPassword) "Hide password" else "Show password", tint = c.fgMuted)
                }
            },
        )
        error?.let { Text(it, style = junoText(TextSize.Sm), color = JunoStatus.danger, modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp)) }
        JunoButton(if (busy) "Please wait…" else if (register) "Create account" else "Log in", ::submit, Modifier.fillMaxWidth(), size = ButtonSize.Hero, enabled = ready && !busy)
        Text(
            if (register) "Already have an account? Log in" else "New here? Create an account",
            style = junoText(TextSize.Sm), color = c.fgMuted,
            modifier = Modifier.clickable { onModeChange(if (register) AuthMode.SignIn else AuthMode.Register); password = ""; error = null }.padding(8.dp),
        )
        Row(Modifier.fillMaxWidth().clickable { serverOpen = !serverOpen }.padding(vertical = 12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Server", style = junoText(TextSize.Sm), color = c.fgMuted)
            Text(if (serverOpen) "Hide" else "Show", style = junoText(TextSize.Sm), color = c.fgSubtle)
        }
        if (serverOpen) {
            JunoTextField(server, { server = it }, "Server address", Modifier.fillMaxWidth(), KeyboardOptions(keyboardType = KeyboardType.Uri))
            Text("Point this at your own server to use it instead of the default.", style = junoText(TextSize.Xs), color = c.fgSubtle)
        }
        Text("Back", style = junoText(TextSize.Sm), color = c.fgMuted, modifier = Modifier.clickable(onClick = onBack).padding(8.dp))
    }
}
