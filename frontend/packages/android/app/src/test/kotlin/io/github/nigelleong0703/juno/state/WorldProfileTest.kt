package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.ProfileEntry
import io.github.nigelleong0703.juno.contract.ProfileSource
import io.github.nigelleong0703.juno.core.ApiException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class WorldProfileTest {
    private val agentEntry = ProfileEntry(
        id = "a", key = "Passport", value = "E1234", visibility = "shared",
        source = ProfileSource(by = "agent", agentId = "ag", at = "2026-10-01T10:00:00Z"),
    )
    private val userEntry = ProfileEntry(id = "b", key = "Email", value = "x@example.com", visibility = null)

    @Test fun `a save sends the whole list in order and a missing visibility as private`() {
        val body = profilePutInput(listOf(agentEntry, userEntry))
        assertEquals(listOf("a", "b"), body.entries!!.map { it.id })
        assertEquals(listOf("shared", "private"), body.entries!!.map { it.visibility })
        assertEquals("E1234", body.entries!![0].value)
    }

    @Test fun `draft limits and blank checks gate the save`() {
        assertTrue(ProfileDraft(key = " Name ", value = " v ").canSave)
        assertFalse(ProfileDraft(key = "   ", value = "v").canSave)
        assertFalse(ProfileDraft(key = "k", value = "").canSave)
        assertFalse(ProfileDraft(key = "k".repeat(PROFILE_KEY_MAX + 1), value = "v").canSave)
        assertTrue(ProfileDraft(key = "k".repeat(PROFILE_KEY_MAX), value = "v".repeat(PROFILE_VALUE_MAX)).canSave)
        assertFalse(ProfileDraft(key = "k", value = "v".repeat(PROFILE_VALUE_MAX + 1)).canSave)
    }

    @Test fun `a new detail is appended trimmed with its visibility`() {
        val out = applyProfileDraft(listOf(userEntry), null, ProfileDraft(" Flight ", " SQ 12 ", shared = true), newId = "new")
        assertEquals(listOf("b", "new"), out.map { it.id })
        assertEquals(ProfileEntry("new", "Flight", "SQ 12", "shared"), out.last())
    }

    @Test fun `an edit keeps the source of the entry it changes`() {
        val out = applyProfileDraft(listOf(agentEntry, userEntry), "a", ProfileDraft("Passport no", "E9999", shared = false), newId = "unused")
        assertEquals("Passport no", out[0].key)
        assertEquals("private", out[0].visibility)
        assertEquals(agentEntry.source, out[0].source)
        assertEquals(userEntry, out[1])
    }

    @Test fun `an edit of a detail removed elsewhere is refused, not dropped`() {
        val failure = assertThrows(ApiException.Http::class.java) {
            applyProfileDraft(listOf(userEntry), "gone", ProfileDraft("k", "v"), newId = "unused")
        }
        assertEquals(404, failure.status)
    }

    @Test fun `source line says who learned a detail and falls back without a date`() {
        assertEquals("Added by you", profileSourceLine(userEntry, agentName = "Ana"))
        assertEquals("Learned by Ana", profileSourceLine(agentEntry.copy(source = ProfileSource(by = "agent", at = null)), agentName = "Ana"))
        assertEquals("Learned by your agent", profileSourceLine(agentEntry.copy(source = ProfileSource(by = "agent")), agentName = null))
    }

    @Test fun `visibility changes one entry and keeps the rest`() {
        val out = setProfileVisibility(listOf(agentEntry, userEntry), "b", shared = true)
        assertEquals("shared", out[1].visibility)
        assertEquals(agentEntry, out[0])
    }
}
