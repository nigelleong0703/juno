package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.App
import io.github.nigelleong0703.juno.contract.AppInstallation
import io.github.nigelleong0703.juno.contract.AppPending
import io.github.nigelleong0703.juno.contract.InstallAppResponse

/** A chat installation projected from the 0.65 Apps contract for the existing per-agent channel screens. */
data class ChannelView(
    val id: String,
    val kind: String,
    val handle: String? = null,
    val displayName: String? = null,
    val botUsername: String? = null,
    val status: String? = null,
    val bound: Boolean? = null,
    val channelId: String? = null,
    val statusMessage: String? = null,
)

/** The connect response projected from InstallAppResponse; the fields are the platform links the flow already offers. */
data class ChannelConnectReply(
    val channel: ChannelView? = null,
    val pending: AppPending? = null,
    val createUrl: String? = null,
    val installUrl: String? = null,
    val verificationUrl: String? = null,
    val channelId: String? = null,
    val manifest: String? = null,
)

fun AppInstallation.channelView(kind: String, agentId: String): ChannelView {
    val workspaceAgent = agents.orEmpty().firstOrNull { it.agentId == agentId }
    return ChannelView(
        id = id, kind = kind, handle = workspaceAgent?.handle, displayName = label, botUsername = label?.removePrefix("@"),
        status = status, bound = bound, channelId = id.substringAfter(':', id), statusMessage = workspaceAgent?.statusMessage,
    )
}

fun InstallAppResponse.channelReply(kind: String, agentId: String) = ChannelConnectReply(
    channel = installation?.channelView(kind, agentId), pending = pending,
    createUrl = openUrl, installUrl = openUrl, verificationUrl = openUrl,
    channelId = prepared?.channelId, manifest = prepared?.manifest,
)

/** The messaging platforms an agent can be reached on. [kind] is the wire value; [title] the name people read. */
enum class ChannelPlatform(val kind: String, val title: String, val mark: String) {
    Telegram("telegram", "Telegram", "T"),
    Slack("slack", "Slack", "S"),
    Discord("discord", "Discord", "D"),
    Feishu("feishu", "Feishu / Lark", "F");

    companion object {
        fun ofKind(kind: String?): ChannelPlatform? = entries.firstOrNull { it.kind == kind }
    }
}

enum class ChannelTone { Warning, Success, Muted }

data class ChannelStatusLine(val text: String, val tone: ChannelTone)

/** What a channel row says about its state (iOS `ChannelsSection.status`). */
fun channelStatusLine(channel: ChannelView): ChannelStatusLine = when (channel.status) {
    "invalid_token", "expired", "error" -> ChannelStatusLine("Needs reconnecting", ChannelTone.Warning)
    "pending_install" -> ChannelStatusLine("Waiting for install", ChannelTone.Warning)
    else -> if (channel.bound == true) ChannelStatusLine("Linked to you", ChannelTone.Success)
    else ChannelStatusLine("Waiting for your first message", ChannelTone.Muted)
}

/** "@handle" when the platform gave the agent a name, else the display name or bot name; never an id. */
fun channelLabel(channel: ChannelView): String {
    channel.handle?.takeIf { it.isNotEmpty() }?.let { return "@$it" }
    return channel.displayName ?: channel.botUsername?.let { "@$it" } ?: ChannelPlatform.ofKind(channel.kind)?.title ?: "Channel"
}

/** The group and invite links of a channel, for its overflow menu. Group actions show only for an active channel. */
object ChannelLinks {
    /** Same bits as the backend's INSTALL_PERMISSIONS for a bot the owner made themselves. */
    const val DISCORD_PERMISSIONS = "274881121408"

    fun telegramChat(channel: ChannelView): String? = telegramBot(channel)?.let { "https://t.me/$it" }

    fun telegramGroup(channel: ChannelView): String? = telegramBot(channel)?.let { "https://t.me/$it?startgroup=true" }

    /** An own Discord bot's channelId is its bot user id (= application id); the shared bot's is "<server>.<agent>", so no invite. */
    fun discordInvite(channel: ChannelView): String? {
        val id = channel.channelId
        if (channel.kind != ChannelPlatform.Discord.kind || id.isNullOrEmpty() || !id.all { it in '0'..'9' }) return null
        return "https://discord.com/oauth2/authorize?client_id=$id&scope=bot%20applications.commands&permissions=$DISCORD_PERMISSIONS"
    }

    fun slackCommand(channel: ChannelView): String? {
        if (channel.kind != ChannelPlatform.Slack.kind) return null
        val name = channel.handle?.takeUnless { it.isEmpty() } ?: channel.displayName
        return if (name.isNullOrEmpty()) null else "/invite @$name"
    }

    fun groupNote(channel: ChannelView): String? {
        if (telegramGroup(channel) != null) return "To read every message in a group, turn off Group Privacy for the bot in @BotFather."
        return slackCommand(channel)?.let { "In Slack, type $it in the channel." }
    }

    private fun telegramBot(channel: ChannelView): String? =
        channel.botUsername?.takeIf { channel.kind == ChannelPlatform.Telegram.kind && it.isNotEmpty() }
}

/** The first link a connect reply offers; the pending copy comes before the top-level one (iOS `ChannelFlow.start`). */
fun connectLink(reply: ChannelConnectReply): String? = listOf(
    reply.pending?.openUrl, reply.createUrl, reply.verificationUrl, reply.installUrl,
).firstOrNull { !it.isNullOrBlank() }

/** The channel of [platform] that was not in [before] (the ids seen when the flow opened): the one this flow created. */
fun newChannelOf(channels: List<ChannelView>, platform: ChannelPlatform, before: Set<String>): ChannelView? =
    channels.firstOrNull { it.kind == platform.kind && it.id !in before }

/** Connect failures the flow answers by changing step instead of showing the message (iOS `ChannelFlow.run`). */
enum class ConnectFailure { SlackConfigMissing, OwnBotOnly }

fun connectFailureOf(code: String?): ConnectFailure? = when (code) {
    "SLACK_CONFIG_TOKEN_MISSING", "SLACK_CONFIG_TOKEN_EXPIRED" -> ConnectFailure.SlackConfigMissing
    "MANAGED_BOTS_UNAVAILABLE", "SHARED_APP_NOT_CONFIGURED" -> ConnectFailure.OwnBotOnly
    else -> null
}
