package io.github.nigelleong0703.juno.ui.settings.channels

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import io.github.nigelleong0703.juno.state.ChannelPlatform
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.components.JunoTextField
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

// The token forms and the Slack steps. Secrets go through [SecretField]: masked, never saved, cleared by the ViewModel.

private val plainInput = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false)
private val secretInput = plainInput.copy(keyboardType = KeyboardType.Password)

@Composable
internal fun TokenStep(platform: ChannelPlatform, state: ChannelFlowState, busy: Boolean, vm: ChannelFlowViewModel) {
    when (platform) {
        ChannelPlatform.Telegram -> {
            SecretField("Bot token", state.botToken) { v -> vm.edit { it.copy(botToken = v) } }
            FlowNote("In Telegram, message @BotFather, send /newbot and copy the token it gives you.")
            ConnectButton(enabled = !busy && state.botToken.isNotBlank(), onClick = vm::submitToken)
        }
        ChannelPlatform.Discord -> {
            SecretField("Bot token", state.botToken) { v -> vm.edit { it.copy(botToken = v) } }
            FlowNote("Developer Portal → your app → Bot → Reset Token. Copy it right away; Discord shows it once.")
            FlowLink("Open the Discord Developer Portal", "https://discord.com/developers/applications")
            ConnectButton(enabled = !busy && state.botToken.isNotBlank(), onClick = vm::submitToken)
        }
        ChannelPlatform.Feishu -> {
            JunoTextField(
                value = state.appId, onValueChange = { v -> vm.edit { it.copy(appId = v) } }, label = "App ID",
                keyboardOptions = plainInput, modifier = Modifier.fillMaxWidth(),
            )
            SecretField("App Secret", state.appSecret) { v -> vm.edit { it.copy(appSecret = v) } }
            FlowNote("From your app's Credentials page. Stored encrypted and never shown again.")
            ConnectButton(enabled = !busy && state.appId.isNotBlank() && state.appSecret.isNotBlank(), onClick = vm::submitToken)
        }
        ChannelPlatform.Slack -> Unit
    }
}

@Composable
internal fun SlackConfigStep(state: ChannelFlowState, busy: Boolean, vm: ChannelFlowViewModel) {
    FlowTitle("App configuration token")
    SecretField("Access token", state.configToken) { v -> vm.edit { it.copy(configToken = v) } }
    SecretField("Refresh token", state.configRefresh) { v -> vm.edit { it.copy(configRefresh = v) } }
    FlowNote("One time only. Create both tokens at api.slack.com/apps, under Your App Configuration Tokens. They let Juno create Slack apps for you.")
    FlowLink("Open api.slack.com/apps", "https://api.slack.com/apps")
    JunoButton(
        text = "Save and continue", onClick = vm::saveSlackConfig,
        enabled = !busy && state.configToken.isNotBlank() && state.configRefresh.isNotBlank(),
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
internal fun SlackManualStep(channelId: String, manifest: String, state: ChannelFlowState, busy: Boolean, vm: ChannelFlowViewModel) {
    val c = JunoTheme.colors
    val context = LocalContext.current
    FlowTitle("1. App manifest")
    SelectionContainer {
        Text(
            manifest, style = junoText(TextSize.Xs).copy(fontFamily = FontFamily.Monospace), color = c.fg,
            maxLines = 14, overflow = TextOverflow.Ellipsis,
        )
    }
    JunoButton(
        text = "Copy manifest", onClick = { context.copyText("Slack app manifest", manifest) },
        variant = ButtonVariant.Secondary, modifier = Modifier.fillMaxWidth(),
    )
    FlowNote("At api.slack.com/apps choose Create New App → From a manifest and paste this. Then Install to Workspace.")
    FlowLink("Open api.slack.com/apps", "https://api.slack.com/apps")
    SecretField("Bot token", state.botToken) { v -> vm.edit { it.copy(botToken = v) } }
    FlowNote("2. Install App → Bot User OAuth Token (starts with xoxb-).")
    SecretField("Signing secret", state.signingSecret) { v -> vm.edit { it.copy(signingSecret = v) } }
    FlowNote("3. Basic Information → App Credentials → Signing Secret.")
    ConnectButton(
        enabled = !busy && state.botToken.isNotBlank() && state.signingSecret.isNotBlank(),
        onClick = { vm.submitSlackManual(channelId) },
    )
}

/** A masked, write-only field: no autocorrect, no capitals, never remembered across process death. */
@Composable
private fun SecretField(label: String, value: String, onChange: (String) -> Unit) {
    JunoTextField(
        value = value, onValueChange = onChange, label = label, keyboardOptions = secretInput,
        visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun ConnectButton(enabled: Boolean, onClick: () -> Unit) {
    JunoButton(text = "Connect", onClick = onClick, enabled = enabled, modifier = Modifier.fillMaxWidth())
}

@Composable
private fun FlowTitle(text: String) {
    Text(text, style = junoText(TextSize.Sm, FontWeight.Medium), color = JunoTheme.colors.fgMuted)
}
