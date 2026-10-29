package io.github.nigelleong0703.juno.ui.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ComposerAndAnchorTest {
    private fun file(status: UploadStatus) = ComposerFile("f", "a.png", "image/png", status)

    @Test fun trailingButtonFollowsTheDraft() {
        assertEquals(Trailing.Mic, ComposerModel().trailing)
        assertEquals(Trailing.Send, ComposerModel(text = "hi").trailing)
        assertEquals(Trailing.Send, ComposerModel(files = listOf(file(UploadStatus.Ready))).trailing)
        assertEquals(Trailing.Stop, ComposerModel(text = "hi", dictation = DictationPhase.Recording).trailing)
        assertEquals(Trailing.Transcribing, ComposerModel(dictation = DictationPhase.Transcribing).trailing)
    }

    @Test fun sendWaitsForUploadsAndFailedOnesBlockIt() {
        assertTrue(ComposerModel(text = "hi", files = listOf(file(UploadStatus.Ready))).canSend)
        assertFalse(ComposerModel(text = "hi", files = listOf(file(UploadStatus.Uploading))).canSend)
        assertFalse(ComposerModel(text = "hi", files = listOf(file(UploadStatus.Failed))).canSend)
        assertFalse(ComposerModel(text = "   ").canSend)
    }

    @Test fun transcriptIsAppendedWithASpaceAndIdleReturns() {
        assertEquals("hello world", ComposerModel(text = "hello ", dictation = DictationPhase.Transcribing).withTranscript(" world ").text)
        assertEquals("only", ComposerModel().withTranscript("only").text)
        assertEquals(DictationPhase.Idle, ComposerModel(dictation = DictationPhase.Transcribing).withTranscript("").dictation)
    }

    @Test fun attachmentCapIsFive() {
        assertTrue(ComposerModel(files = List(4) { file(UploadStatus.Ready) }).canAttachMore)
        assertFalse(ComposerModel(files = List(5) { file(UploadStatus.Ready) }).canAttachMore)
    }

    @Test fun pagingStartsWithinOneAndAHalfScreensOfTheOldestRow() {
        // 10 visible rows: look ahead 15 rows from the oldest of 100.
        assertFalse(TranscriptMath.shouldLoadOlder(lastVisibleIndex = 80, visibleCount = 10, total = 100))
        assertTrue(TranscriptMath.shouldLoadOlder(lastVisibleIndex = 84, visibleCount = 10, total = 100))
        assertFalse(TranscriptMath.shouldLoadOlder(0, 0, 0))
    }

    @Test fun jumpButtonShowsFarFromNewestOrWhenDetached() {
        assertFalse(TranscriptMath.showJump(100f, detached = false))
        assertTrue(TranscriptMath.showJump(141f, detached = false))
        assertTrue(TranscriptMath.showJump(0f, detached = true))
    }

    @Test fun myMessageAlwaysFollowsOthersOnlyAtTheBottom() {
        assertTrue(TranscriptMath.followNewest("a", "b", newestIsMine = true, wasAtBottom = false))
        assertFalse(TranscriptMath.followNewest("a", "b", newestIsMine = false, wasAtBottom = false))
        assertTrue(TranscriptMath.followNewest("a", "b", newestIsMine = false, wasAtBottom = true))
        assertFalse(TranscriptMath.followNewest("b", "b", newestIsMine = true, wasAtBottom = true))
    }

    @Test fun typingIsThrottledToOnePerSecondWithATrailingFalse() {
        val gate = TypingGate()
        assertEquals(true, gate.onDraft("h", 0))
        assertNull(gate.onDraft("he", 400))
        assertEquals(true, gate.onDraft("hel", 1100))
        assertEquals(false, gate.onDraft("", 1200))
        assertNull(gate.onDraft("", 1300))
    }
}
