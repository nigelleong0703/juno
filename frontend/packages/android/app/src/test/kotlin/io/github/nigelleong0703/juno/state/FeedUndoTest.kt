package io.github.nigelleong0703.juno.state

import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FeedUndoTest {
    private fun dismissal(post: String) = FeedDismissal(postId = post, previous = null, reason = "topic", note = null, text = "Got it.")

    @Test fun sendsOnlyWhenTheFiveSecondWindowCloses() = runTest {
        val flushed = mutableListOf<String>()
        val undo = FeedUndo(backgroundScope, windowMs = 5_000) { flushed += it.postId }
        undo.begin(dismissal("a"))
        advanceTimeBy(4_999)
        runCurrent()
        assertTrue(flushed.isEmpty())
        advanceTimeBy(1)
        runCurrent()
        assertEquals(listOf("a"), flushed)
    }

    @Test fun undoInsideTheWindowSendsNothing() = runTest {
        val flushed = mutableListOf<String>()
        val undo = FeedUndo(backgroundScope, windowMs = 5_000) { flushed += it.postId }
        undo.begin(dismissal("a"))
        advanceTimeBy(2_000)
        assertEquals("a", undo.undo()?.postId)
        advanceTimeBy(10_000)
        runCurrent()
        assertTrue(flushed.isEmpty())
        assertNull(undo.current)
    }

    @Test fun anotherDismissalFlushesThePendingOneAtOnce() = runTest {
        val flushed = mutableListOf<String>()
        val undo = FeedUndo(backgroundScope, windowMs = 5_000) { flushed += it.postId }
        undo.begin(dismissal("a"))
        advanceTimeBy(1_000)
        undo.begin(dismissal("b"))
        // "a" went out when "b" started, not at its own five seconds.
        assertEquals(listOf("a"), flushed)
        advanceTimeBy(4_000)
        runCurrent()
        // "b" still has its own full window: its timer started at 1 s.
        assertEquals(listOf("a"), flushed)
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(listOf("a", "b"), flushed)
    }

    @Test fun flushNowSendsThePendingDismissalOnce() = runTest {
        val flushed = mutableListOf<String>()
        val undo = FeedUndo(backgroundScope, windowMs = 5_000) { flushed += it.postId }
        undo.begin(dismissal("a"))
        undo.flush()
        undo.flush()
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(listOf("a"), flushed)
    }
}
