package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.AppPending
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ChannelModelsTest {
    private fun channel(
        id: String = "row", kind: String, channelId: String? = null, handle: String? = null, displayName: String? = null,
        botUsername: String? = null, status: String? = "active", bound: Boolean? = null,
    ) = ChannelView(
        id = id, kind = kind, channelId = channelId, handle = handle, displayName = displayName,
        botUsername = botUsername, status = status, bound = bound,
    )

    @Test fun `status line follows the channel state and bound flag`() {
        assertEquals(ChannelStatusLine("Needs reconnecting", ChannelTone.Warning), channelStatusLine(channel(kind = "telegram", status = "invalid_token")))
        assertEquals(ChannelStatusLine("Waiting for install", ChannelTone.Warning), channelStatusLine(channel(kind = "slack", status = "pending_install")))
        assertEquals(ChannelStatusLine("Linked to you", ChannelTone.Success), channelStatusLine(channel(kind = "discord", bound = true)))
        assertEquals(ChannelStatusLine("Waiting for your first message", ChannelTone.Muted), channelStatusLine(channel(kind = "discord", bound = false)))
    }

    @Test fun `label prefers the handle, then the display name, then the bot name, never the id`() {
        assertEquals("@nova", channelLabel(channel(kind = "slack", handle = "nova", displayName = "Nova")))
        assertEquals("Nova", channelLabel(channel(kind = "slack", handle = "", displayName = "Nova")))
        assertEquals("@nova_bot", channelLabel(channel(kind = "telegram", botUsername = "nova_bot")))
        assertEquals("Telegram", channelLabel(channel(id = "123", kind = "telegram")))
    }

    @Test fun `discord invite needs an all-digit channel id`() {
        val own = channel(kind = "discord", channelId = "1234567890")
        assertEquals(
            "https://discord.com/oauth2/authorize?client_id=1234567890&scope=bot%20applications.commands&permissions=274881121408",
            ChannelLinks.discordInvite(own),
        )
        assertNull(ChannelLinks.discordInvite(channel(kind = "discord", channelId = "42.nova")))
        assertNull(ChannelLinks.discordInvite(channel(kind = "discord", channelId = "")))
        assertNull(ChannelLinks.discordInvite(channel(kind = "discord", channelId = null)))
        assertNull(ChannelLinks.discordInvite(channel(kind = "slack", channelId = "1234")))
    }

    @Test fun `telegram group link and note need the bot name, slack command falls back to the display name`() {
        val bot = channel(kind = "telegram", botUsername = "nova_bot")
        assertEquals("https://t.me/nova_bot?startgroup=true", ChannelLinks.telegramGroup(bot))
        assertEquals("https://t.me/nova_bot", ChannelLinks.telegramChat(bot))
        assertNull(ChannelLinks.telegramGroup(channel(kind = "telegram", botUsername = "")))
        assertEquals(
            "To read every message in a group, turn off Group Privacy for the bot in @BotFather.",
            ChannelLinks.groupNote(bot),
        )
        assertEquals("/invite @Nova", ChannelLinks.slackCommand(channel(kind = "slack", handle = "", displayName = "Nova")))
        assertEquals("In Slack, type /invite @Nova in the channel.", ChannelLinks.groupNote(channel(kind = "slack", displayName = "Nova")))
    }

    @Test fun `connect link prefers the pending copy and skips blanks`() {
        val reply = ChannelConnectReply(
            pending = AppPending(id = "p", openUrl = "https://feishu.example/verify"),
            installUrl = "https://top.example/install",
        )
        assertEquals("https://feishu.example/verify", connectLink(reply))
        assertNull(connectLink(ChannelConnectReply()))
    }

    @Test fun `a new channel is one of this kind that was not there before`() {
        val channels = listOf(
            channel(id = "old", kind = "telegram", botUsername = "a"),
            channel(id = "other", kind = "slack"),
            channel(id = "fresh", kind = "telegram", botUsername = "b"),
        )
        assertEquals("fresh", newChannelOf(channels, ChannelPlatform.Telegram, before = setOf("old"))?.id)
        assertNull(newChannelOf(channels, ChannelPlatform.Feishu, before = emptySet()))
    }

    @Test fun `only the Slack config and the own-bot errors change the step`() {
        assertEquals(ConnectFailure.SlackConfigMissing, connectFailureOf("SLACK_CONFIG_TOKEN_EXPIRED"))
        assertEquals(ConnectFailure.OwnBotOnly, connectFailureOf("SHARED_APP_NOT_CONFIGURED"))
        assertNull(connectFailureOf("INVALID_TOKEN"))
        assertNull(connectFailureOf(null))
    }
}
