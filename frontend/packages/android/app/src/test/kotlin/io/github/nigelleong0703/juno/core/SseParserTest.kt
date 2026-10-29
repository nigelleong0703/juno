package io.github.nigelleong0703.juno.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SseParserTest {
    private fun feedAll(parser: SseParser, vararg lines: String) = lines.mapNotNull { parser.feed(it) }

    @Test fun `a blank line ends the event and carries the id as cursor`() {
        val frames = feedAll(SseParser(), "id: 7", "data: {\"type\":\"a\"}", "")
        assertEquals(listOf(EventFrame(7, "{\"type\":\"a\"}")), frames)
    }

    @Test fun `multi-line data is joined with a newline`() {
        assertEquals("one\ntwo", feedAll(SseParser(), "data: one", "data:two", "").single().data)
    }

    @Test fun `comments and keep-alives yield nothing`() {
        assertTrue(feedAll(SseParser(), ": ping", "").isEmpty())
    }

    @Test fun `a blank line with no data yields nothing`() {
        assertNull(SseParser().feed(""))
    }

    @Test fun `reset event clears the resume cursor`() {
        val parser = SseParser(lastId = "9")
        val frame = feedAll(parser, "event: reset", "").single()
        assertTrue(frame.isReset)
        assertNull(parser.lastId)
    }

    @Test fun `state does not leak between events`() {
        val parser = SseParser()
        feedAll(parser, "event: reset", "")
        val next = feedAll(parser, "id: 3", "data: x", "").single()
        assertEquals(EventFrame(3, "x"), next)
    }

    @Test fun `the cursor survives for reconnect after an event`() {
        val parser = SseParser()
        feedAll(parser, "id: 12", "data: x", "")
        assertEquals("12", parser.lastId)
    }
}
