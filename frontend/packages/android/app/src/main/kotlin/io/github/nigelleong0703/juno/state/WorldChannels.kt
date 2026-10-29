package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.App
import io.github.nigelleong0703.juno.contract.ConnectChannelInput
import io.github.nigelleong0703.juno.contract.InstallAppChatInput
import io.github.nigelleong0703.juno.contract.InstallAppResponse
import io.github.nigelleong0703.juno.contract.SlackConfigTokenInput
import io.github.nigelleong0703.juno.contract.SlackConfigTokenStatus
import io.github.nigelleong0703.juno.core.ApiException
import io.github.nigelleong0703.juno.core.JunoJson
import io.github.nigelleong0703.juno.core.ListResponse
import java.io.IOException

// An agent's messaging channels (Telegram, Slack, Discord, Feishu / Lark). Each function is one request and throws on
// failure. The screens keep the list themselves: iOS keeps it on `World.channels`, which WorldState does not carry yet.

/** The chat apps and installations that include this agent (GET /v1/apps). */
suspend fun World.refreshChannels(agentId: String): List<ChannelView> {
    val api = api ?: throw ApiException.NotSignedIn
    return api.get<ListResponse<App>>("/v1/apps").items.filter { it.category == "chat" }.flatMap { app ->
        app.installations.orEmpty().filter { installation ->
            installation.agentId == agentId || installation.agents.orEmpty().any { it.agentId == agentId }
        }.map { it.channelView(app.id, agentId) }
    }
}

/**
 * One connect request. The reply carries what the platform needs next (bind code, install / create / verification link,
 * manifest) or, for a manual connect, the channel itself.
 */
suspend fun World.connectChannel(agentId: String, kind: String, input: ConnectChannelInput): ChannelConnectReply {
    val api = api ?: throw ApiException.NotSignedIn
    val body = InstallAppChatInput(
        agentId = agentId, mode = input.mode, botToken = input.botToken, suggestedUsername = input.suggestedUsername,
        channelId = input.channelId, signingSecret = input.signingSecret, appId = input.appId,
        appSecret = input.appSecret, domain = input.domain,
    )
    return JunoJson.decodeFromString<InstallAppResponse>(api.post("/v1/apps/$kind/install", body)).channelReply(kind, agentId)
}

/** DELETE one installation from its app; the app id is the platform kind. */
suspend fun World.disconnectChannel(agentId: String, channel: ChannelView) {
    val api = api ?: throw ApiException.NotSignedIn
    api.delete("/v1/apps/${channel.kind}/installations/${channel.id}")
}

/** Whether the server holds a Slack app configuration token. A failed read counts as "no", as on iOS. */
suspend fun World.slackConfigTokenConfigured(): Boolean {
    val api = api ?: return false
    return try {
        api.get<SlackConfigTokenStatus>("/v1/channels/slack/config-token").configured == true
    } catch (e: ApiException) {
        false
    } catch (e: IOException) {
        false
    }
}

/** Write-only: the server never returns the tokens. */
suspend fun World.saveSlackConfigToken(token: String, refreshToken: String) {
    val api = api ?: throw ApiException.NotSignedIn
    api.put("/v1/channels/slack/config-token", SlackConfigTokenInput(token = token, refreshToken = refreshToken))
}
