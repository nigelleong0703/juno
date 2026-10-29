package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.Agent
import io.github.nigelleong0703.juno.contract.Conversation
import io.github.nigelleong0703.juno.contract.Item
import io.github.nigelleong0703.juno.core.Session
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class LocalStoreTest {
    @get:Rule val tmp = TemporaryFolder()

    private val me = Session(server = "http://10.0.2.2:8787", token = "t", userId = "u1", name = "Ann", email = "a@x.dev")
    private fun store() = LocalStore(File(tmp.root, "juno-store"))

    private val older = Item(id = "m1", conversationId = "c1", at = "2026-10-01T09:00:00Z", type = "user_message", text = "hi")
    private val newest = Item(id = "m2", conversationId = "c1", at = "2026-10-01T09:01:00Z", type = "agent_message", text = "hello")
    private val unsent = Item(id = "local-1", conversationId = "c1", at = "2026-10-01T09:02:00Z", type = "user_message", text = "x")

    private fun state(detached: Boolean = false) = WorldState(
        selfId = "u1",
        conversations = listOf(Conversation(id = "c1", title = "Plans")),
        agents = listOf(Agent(id = "a1", name = "Ada", status = "working")),
        items = mapOf("c1" to listOf(older, newest, unsent)),
        history = mapOf("c1" to ChatHistory(olderCursor = "cur-9", detached = detached)),
        sending = setOf("local-1"),
    )

    @Test fun roundtripRestoresListsAndChatWindowWithoutUnsentMessages() {
        val store = store()
        store.save(me, LocalSnapshot.capture(state()))

        val restored = store.load(me)!!.applyTo(WorldState(selfId = "u1"))

        assertEquals("Plans", restored.conversations.single().title)
        assertEquals("Ada", restored.agents.single().name)
        assertEquals(listOf(older, newest), restored.items["c1"])
        assertEquals("cur-9", restored.history["c1"]?.olderCursor)
        assertEquals("u1", restored.selfId)
    }

    @Test fun agentsMidWorkReadAsIdleOnColdStart() {
        val store = store()
        store.save(me, LocalSnapshot.capture(state()))
        assertEquals("idle", store.load(me)!!.applyTo(WorldState()).agents.single().status)
    }

    @Test fun detachedChatIsNotStored() {
        assertTrue(LocalSnapshot.capture(state(detached = true)).chats.isEmpty())
    }

    @Test fun corruptedFileIsIgnored() {
        val store = store()
        store.save(me, LocalSnapshot.capture(state()))
        File(tmp.root, "juno-store").listFiles()!!.single().writeText("{\"conversations\": [")
        assertNull(store.load(me))
    }

    @Test fun otherVersionIsDropped() {
        val store = store()
        store.save(me, LocalSnapshot(version = LocalStore.VERSION + 1, conversations = listOf(Conversation(id = "c1"))))
        assertNull(store.load(me))
    }

    @Test fun signOutClearsEveryAccount() {
        val store = store()
        val other = me.copy(userId = "u2")
        store.save(me, LocalSnapshot.capture(state()))
        store.save(other, LocalSnapshot.capture(state()))

        store.clear()

        assertNull(store.load(me))
        assertNull(store.load(other))
        assertFalse(File(tmp.root, "juno-store").exists())
    }

    @Test fun accountsDoNotSeeEachOther() {
        val store = store()
        store.save(me, LocalSnapshot.capture(state()))
        assertNull(store.load(me.copy(userId = "u2")))
    }

    @Test fun saveAfterSignOutWritesNothing() {
        val store = store()
        store.save(me, LocalSnapshot.capture(state()), stillSignedIn = { false })
        assertNull(store.load(me))
    }
}
