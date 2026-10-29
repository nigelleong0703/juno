package io.github.nigelleong0703.juno.state

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ScreenStreamUrlTest {
    private val ticket = "ws://127.0.0.1:9000/v1/screens/s1/vnc?token=abc%2Bdef&exp=1"

    @Test fun pinsHostSchemeAndPortToTheSignedInServerKeepingPathAndQuery() {
        assertEquals("ws://10.0.2.2:8787/v1/screens/s1/vnc?token=abc%2Bdef&exp=1", ScreenStreamUrl.pin(ticket, true, true, "s1", "http://10.0.2.2:8787"))
        assertEquals("wss://juno.example.com/v1/screens/s1/vnc?token=abc%2Bdef&exp=1", ScreenStreamUrl.pin(ticket, true, true, "s1", "https://juno.example.com"))
    }

    @Test fun rejectsAnotherScreensOrAnotherPath() {
        assertNull(ScreenStreamUrl.pin("ws://h/v1/screens/other/vnc?t=1", true, true, "s1", "https://x.io"))
        assertNull(ScreenStreamUrl.pin("ws://h/v1/screens/s1/vnc/../../admin", true, true, "s1", "https://x.io"))
        assertNull(ScreenStreamUrl.pin("ws://h/v1/screens/s1/screenshot", null, false, "s1", "https://x.io"))
    }

    @Test fun controlRequestedNeedsAControlTicket() {
        assertNull(ScreenStreamUrl.pin(ticket, false, true, "s1", "https://x.io"))
        assertNull(ScreenStreamUrl.pin(ticket, null, true, "s1", "https://x.io"))
        // View-only was asked for: a ticket without the flag is fine.
        assertEquals("wss://x.io/v1/screens/s1/vnc?token=abc%2Bdef&exp=1", ScreenStreamUrl.pin(ticket, null, false, "s1", "https://x.io"))
    }

    @Test fun badServerOrTicketGivesNull() {
        assertNull(ScreenStreamUrl.pin(ticket, true, true, "s1", "not a url"))
        assertNull(ScreenStreamUrl.pin("::not a uri::", true, true, "s1", "https://x.io"))
    }
}

class TakeoverDialTest {
    @Test fun controlTicketAlwaysFollowsTheTakeOverAndSucceedingStopsTheLoop() = runBlocking {
        val log = ArrayList<String>()
        var tickets = 0
        val url = TakeoverDial.run({ log += "takeover" }, { log += "ticket"; if (++tickets == 3) "wss://ok" else null }, { log += "wait$it" })
        assertEquals("wss://ok", url)
        assertEquals(listOf("takeover", "ticket", "wait400", "takeover", "ticket", "wait800", "takeover", "ticket"), log)
    }

    @Test fun givesUpAfterThreeAttemptsWithGrowingWaits() = runBlocking {
        val log = ArrayList<String>()
        val url = TakeoverDial.run<String>({ log += "takeover" }, { log += "ticket"; null }, { log += "wait$it" })
        assertNull(url)
        assertEquals(listOf("takeover", "ticket", "wait400", "takeover", "ticket", "wait800", "takeover", "ticket", "wait1200"), log)
    }

    @Test fun firstTryDoesNotWait() = runBlocking {
        val log = ArrayList<String>()
        assertEquals("u", TakeoverDial.run({ log += "takeover" }, { log += "ticket"; "u" }, { log += "wait" }))
        assertEquals(listOf("takeover", "ticket"), log)
    }
}
