package io.github.nigelleong0703.juno.ui.settings.channels

import io.github.nigelleong0703.juno.ui.components.JunoIcons

import androidx.compose.foundation.layout.Arrangement
import io.github.nigelleong0703.juno.ui.components.openLink
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.nigelleong0703.juno.state.ChannelConnectReply
import io.github.nigelleong0703.juno.state.ChannelPlatform
import io.github.nigelleong0703.juno.ui.components.ButtonVariant
import io.github.nigelleong0703.juno.ui.components.JunoButton
import io.github.nigelleong0703.juno.ui.theme.JunoStatus
import io.github.nigelleong0703.juno.ui.theme.JunoTheme
import io.github.nigelleong0703.juno.ui.theme.TextSize
import io.github.nigelleong0703.juno.ui.theme.junoText

/** The flow waits for the user to finish on the platform; the ViewModel polls and moves on when the channel appears. */
@Composable
internal fun WaitingStep(platform: ChannelPlatform, url: String?) {
    val c = JunoTheme.colors
    val context = LocalContext.current
    val name = if (platform == ChannelPlatform.Feishu) "Feishu" else platform.title
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = c.fgMuted)
        Spacer(Modifier.size(10.dp))
        Text("Waiting for you to finish in $name…", style = junoText(TextSize.Base), color = c.fgMuted)
    }
    url?.let {
        JunoButton(
            text = "Open again", onClick = { context.openLink(it) },
            variant = ButtonVariant.Secondary, modifier = Modifier.fillMaxWidth(),
        )
    }
    FlowNote("This screen updates by itself once the channel is connected.")
}

/** After a connect: "Connected", the platform's link (open the bot, add it to a server) and what to do next. */
@Composable
internal fun CodeStep(platform: ChannelPlatform, reply: ChannelConnectReply, onDone: () -> Unit) {
    val c = JunoTheme.colors
    val context = LocalContext.current
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(JunoIcons.CheckCircle, contentDescription = null, tint = JunoStatus.success)
        Text("Connected", style = junoText(TextSize.Md, FontWeight.SemiBold), color = c.fg)
    }
    Text(
        if (reply.installUrl == null) "Message your bot to start." else "Open the chat to start.",
        style = junoText(TextSize.Base), color = c.fgMuted,
    )
    FlowNote("Your first message links your account, so the bot treats what you send as instructions.")
    reply.installUrl?.let { url ->
        JunoButton(text = "Open in Telegram", onClick = { context.openLink(url) }, variant = ButtonVariant.Secondary, modifier = Modifier.fillMaxWidth())
    }
    reply.installUrl?.let { url ->
        val label = if (platform == ChannelPlatform.Discord) "Add the bot to a server" else "Install the app"
        JunoButton(text = label, onClick = { context.openLink(url) }, variant = ButtonVariant.Secondary, modifier = Modifier.fillMaxWidth())
    }
    JunoButton(text = "Done", onClick = onDone, modifier = Modifier.fillMaxWidth())
}
