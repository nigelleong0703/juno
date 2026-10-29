package io.github.nigelleong0703.juno.ui.chat

import io.github.nigelleong0703.juno.contract.Agent
import io.github.nigelleong0703.juno.contract.Conversation
import io.github.nigelleong0703.juno.contract.Mention
import io.github.nigelleong0703.juno.contract.Request
import io.github.nigelleong0703.juno.contract.Run
import io.github.nigelleong0703.juno.state.WorldState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatListLogicTest {
    private val direct = Conversation(id = "d", kind = "direct", agentIds = listOf("a1"), lastItemAt = "2026-10-22T10:00:00Z", unreadCount = 2)
    private val pinnedOld = Conversation(id = "p", kind = "direct", agentIds = listOf("a2"), lastItemAt = "2026-10-01T10:00:00Z", pinned = true)
    private val room = Conversation(id = "r", kind = "room", agentIds = listOf("a1", "a2"), lastItemAt = "2026-10-21T10:00:00Z")
    private val slack = Conversation(id = "s", kind = "room", title = "#work", channel = Conversation.Channel(kind = "slack"), lastItemAt = "2026-10-20T10:00:00Z")
    private val task = Conversation(id = "t", kind = "task", lastItemAt = "2026-10-19T10:00:00Z")
    private val state = WorldState(
        conversations = listOf(direct, pinnedOld, room, slack, task),
        agents = listOf(Agent(id = "a1", name = "Mia"), Agent(id = "a2", name = "Bo")),
        requests = listOf(
            Request(id = "q1", kind = "approval", status = "pending", conversationId = "d", createdAt = "2026-10-22T09:00:00Z"),
            // A question in a direct chat is the agent talking, not "needs you".
            Request(id = "q2", kind = "question", status = "pending", conversationId = "p"),
        ),
    )

    @Test fun allHidesPlatformAndTaskChatsAndPinnedComesFirst() {
        assertEquals(listOf("p", "d", "r"), ChatListLogic.visible(state, ChatFilter.All).map { it.id })
    }

    @Test fun filtersFollowTheSpecRules() {
        assertEquals(listOf("d"), ChatListLogic.visible(state, ChatFilter.Unread).map { it.id })
        assertEquals(listOf("d"), ChatListLogic.visible(state, ChatFilter.NeedsYou).map { it.id })
        assertEquals(listOf("r"), ChatListLogic.visible(state, ChatFilter.Groups).map { it.id })
        assertEquals(listOf("s"), ChatListLogic.visible(state, ChatFilter.Platform("slack")).map { it.id })
        // A platform chip whose chats are gone falls back to All.
        assertEquals(3, ChatListLogic.visible(state, ChatFilter.Platform("telegram")).size)
        assertEquals(listOf("slack"), ChatListLogic.platforms(state))
    }

    @Test fun subtitleWorkingBeatsAskBeatsPreview() {
        assertTrue(ChatListLogic.subtitle(state, direct) is ChatListLogic.Subtitle.Ask)
        val working = state.copy(runs = listOf(Run(id = "r1", conversationId = "d", status = "running", title = "Report")))
        assertEquals(ChatListLogic.Subtitle.Working("Report"), ChatListLogic.subtitle(working, direct))
        assertEquals(ChatListLogic.Subtitle.Preview("hi"), ChatListLogic.subtitle(state, pinnedOld.copy(lastMessagePreview = "hi")))
    }

    @Test fun composedTodayCountsOnlyRealAsksAndNewUserHasNoAgents() {
        val today = TodaySummary.build(state, null)
        assertEquals(1, today.needsYouCount)
        val empty = TodaySummary.build(WorldState(), null)
        assertEquals(0, empty.needsYouCount)
        assertTrue(empty.working.isEmpty())
        assertTrue(empty.completed.isEmpty())
    }

    @Test fun mentionsPickerAndBuild() {
        assertEquals("", Mentions.activeQuery("hi @"))
        assertEquals("mi", Mentions.activeQuery("hi @mi"))
        assertNull(Mentions.activeQuery("mail@x"))
        assertEquals("hi @Mia ", Mentions.completing("hi @mi", "Mia"))
        val picked = listOf(Mention(kind = "agent", id = "a1", label = "@Mia"))
        assertEquals(listOf("a1", "all"), Mentions.build("@Mia and @all `@Bo`", picked).map { it.id })
    }
}
