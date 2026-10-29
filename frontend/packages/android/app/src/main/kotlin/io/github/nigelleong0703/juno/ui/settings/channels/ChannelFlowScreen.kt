package io.github.nigelleong0703.juno.ui.settings.channels

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.background
import io.github.nigelleong0703.juno.ui.components.openLink
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import io.github.nigelleong0703.juno.contract.ConnectChannelInput
import io.github.nigelleong0703.juno.state.ChannelPlatform
import io.github.nigelleong0703.juno.state.LocalWorld
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.settings.SettingsError
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.Radius
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/**
 * One platform's connect flow in the Add channel sheet: one screen that swaps its step as the flow goes on. [session]
 * keys the flow's ViewModel to this opening of the sheet, so a reopened sheet starts fresh.
 */
@Composable
fun ChannelFlowScreen(agentId: String, platform: ChannelPlatform, session: String, onBack: () -> Unit, onDone: () -> Unit) {
    val world = LocalWorld.current
    val vm: ChannelFlowViewModel = viewModel(
        key = "$agentId/${platform.kind}/$session",
        factory = viewModelFactory { initializer { ChannelFlowViewModel(world, agentId, platform) } },
    )
    val state by vm.state.collectAsState()
    val context = LocalContext.current
    LaunchedEffect(vm) { vm.links.collect { context.openLink(it) } }
    DisposableEffect(vm) { onDispose { vm.close() } }

    val phase = state.phase
    val busy = state.busy
    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        FlowHeader(
            title = platform.title,
            onBack = when (phase) {
                FlowPhase.Choose -> onBack
                is FlowPhase.Code -> onDone
                else -> vm::back
            },
        )
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        state.error?.let { SettingsError(it) }
        when (phase) {
            FlowPhase.Choose -> ChooseStep(platform, state.domain, busy, vm)
            // Discord has no own-bot choices: its own-bot path is the token form.
            FlowPhase.Own -> if (platform == ChannelPlatform.Discord) TokenStep(platform, state, busy, vm) else OwnStep(platform, busy, vm)
            FlowPhase.Token -> TokenStep(platform, state, busy, vm)
            FlowPhase.SlackConfig -> SlackConfigStep(state, busy, vm)
            is FlowPhase.SlackManual -> SlackManualStep(phase.channelId, phase.manifest, state, busy, vm)
            is FlowPhase.Waiting -> WaitingStep(platform, phase.url)
            is FlowPhase.Code -> CodeStep(platform, phase.reply, onDone)
        }
    }
}

@Composable
private fun FlowHeader(title: String, onBack: () -> Unit) {
    val c = JunoTheme.colors
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onBack) { Icon(JunoIcons.ChevronLeft, "Back", tint = c.fg) }
        Text(title, style = junoText(TextSize.Lg, FontWeight.SemiBold), color = c.fg)
    }
}

@Composable
private fun ChooseStep(platform: ChannelPlatform, domain: String, busy: Boolean, vm: ChannelFlowViewModel) {
    if (platform == ChannelPlatform.Feishu) {
        val regions = listOf(ConnectChannelInput.DomainValue.feishu to "Feishu", ConnectChannelInput.DomainValue.lark to "Lark")
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            regions.forEachIndexed { i, (value, label) ->
                SegmentedButton(
                    selected = domain == value, enabled = !busy,
                    onClick = { vm.edit { it.copy(domain = value) } },
                    shape = SegmentedButtonDefaults.itemShape(index = i, count = regions.size),
                ) { Text(label) }
            }
        }
        FlowNote("Feishu for accounts on feishu.cn, Lark for accounts on larksuite.com.")
    }
    JunoButton(text = "Connect ${platform.title}", onClick = vm::connectPrimary, enabled = !busy, modifier = Modifier.fillMaxWidth())
    FlowNote(connectHelp(platform))
    // Connect reuses the workspace or server the app is already in; another one needs its install link again.
    if (platform == ChannelPlatform.Slack || platform == ChannelPlatform.Discord) {
        val where = if (platform == ChannelPlatform.Discord) "server" else "workspace"
        JunoButton(
            text = "Add to another $where", onClick = vm::connectElsewhere, enabled = !busy,
            variant = ButtonVariant.Ghost, modifier = Modifier.fillMaxWidth(),
        )
    }
    JunoButton(
        text = "Use my own bot", onClick = vm::showOwn, enabled = !busy,
        variant = ButtonVariant.Ghost, modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun OwnStep(platform: ChannelPlatform, busy: Boolean, vm: ChannelFlowViewModel) {
    when (platform) {
        ChannelPlatform.Telegram -> OwnOption("Use my bot token", "Paste the token from @BotFather.", busy, vm::showToken)
        ChannelPlatform.Slack -> {
            OwnOption(
                "Create the app for me",
                "Juno creates the Slack app with your configuration token; you only install it.",
                busy, vm::createSlackForMe,
            )
            OwnOption("I'll create it", "Create the app from a manifest yourself, then paste its tokens.", busy, vm::prepareSlack)
        }
        ChannelPlatform.Feishu -> OwnOption("I'll create it", "Paste the App ID and App Secret of an app you made.", busy, vm::showToken)
        ChannelPlatform.Discord -> Unit
    }
}

@Composable
private fun OwnOption(title: String, detail: String, busy: Boolean, onClick: () -> Unit) {
    val c = JunoTheme.colors
    Column(
        Modifier.fillMaxWidth().background(c.card, RoundedCornerShape(Radius.lg))
            .border(1.dp, c.border, RoundedCornerShape(Radius.lg))
            .clickable(enabled = !busy, onClick = onClick).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(title, style = junoText(TextSize.Md, FontWeight.Medium), color = c.fg)
        Text(detail, style = junoText(TextSize.Sm), color = c.fgMuted)
    }
}

/** A footer-style note under a step (iOS section footer). */
@Composable
internal fun FlowNote(text: String) {
    Text(text, style = junoText(TextSize.Xs), color = JunoTheme.colors.fgSubtle)
}

/** A text link that opens in the browser (iOS `Link`). */
@Composable
internal fun FlowLink(label: String, url: String) {
    val context = LocalContext.current
    TextButton(onClick = { context.openLink(url) }) { Text(label, style = junoText(TextSize.Sm, FontWeight.Medium)) }
}

private fun connectHelp(platform: ChannelPlatform): String = when (platform) {
    ChannelPlatform.Telegram -> "Telegram opens and you confirm the new bot. Nothing to copy."
    ChannelPlatform.Slack -> "Your browser opens so you can add Juno to your Slack workspace."
    ChannelPlatform.Discord -> "Your browser opens so you can add Juno to your Discord server."
    ChannelPlatform.Feishu -> "Open a Feishu page and approve the new app."
}
