package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.LibraryItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MemoryAndLibraryRulesTest {
    private val personPage = """
        # Ana
        Likes tea. (ASCII parens are text.)

        ## Ana（agent-1）
        Met at school.

        ## Plain heading
        not a section

        ## Ben（agent-2）
        Co-worker.
    """.trimIndent() + "\n"

    @Test fun personPageSplitsOnFullWidthHeadingsOnly() {
        val split = PersonPage.split(personPage)
        assertEquals(listOf("Ana（agent-1）", "Ben（agent-2）"), split.sections.map { it.heading })
        // A plain "## " heading is not a separator: it stays inside the section text above it.
        assertEquals("Met at school.\n\n## Plain heading\nnot a section", split.sections[0].text)
        assertEquals(true, split.body.contains("Likes tea"))
    }

    @Test fun personPageSurvivesASaveRoundTrip() {
        val split = PersonPage.split(personPage)
        val again = PersonPage.split(PersonPage.join(split.body, split.sections))
        assertEquals(split.body, again.body)
        assertEquals(split.sections, again.sections)
    }

    @Test fun personPageWithoutSectionsIsAllBody() {
        val split = PersonPage.split("# Solo\nJust the body.\n")
        assertEquals(0, split.sections.size)
    }

    @Test fun personNameIsTheFirstHeadingElseTheFileName() {
        assertEquals("Ana", PersonPage.name("people/ana.md", "# Ana\nx"))
        assertEquals("ana", PersonPage.name("people/ana.md", "no heading"))
    }

    @Test fun dailyNotesOnlyCountTheDatedAgentFileShape() {
        assertEquals(DailyNotePath("2026-10-22", "agent-1"), DailyNotes.parse("memory/2026-10-22/agent-1.md"))
        assertNull(DailyNotes.parse("memory/bank/preferences.md"))
        assertNull(DailyNotes.parse("memory/2026-10-22/agent-1.txt"))
        assertNull(DailyNotes.parse("memory/2026-10-22/nested/agent-1.md"))
    }

    private fun item(source: String? = null, render: String? = null, kind: String? = null, mime: String? = null) =
        LibraryItem(id = "x", source = source, render = render, kind = kind, mimeType = mime)

    @Test fun uploadsNeverAppearInTheLibrary() {
        assertNull(LibraryGroup.of(item(source = "upload", render = "html")))
    }

    @Test fun interactivePagesAndAppsAreTools() {
        assertEquals(LibraryGroup.Tools, LibraryGroup.of(item(source = "agent", render = "html")))
        assertEquals(LibraryGroup.Tools, LibraryGroup.of(item(render = "app")))
    }

    @Test fun picturesAndVideoAreMedia() {
        assertEquals(LibraryGroup.Media, LibraryGroup.of(item(render = "image")))
        assertEquals(LibraryGroup.Media, LibraryGroup.of(item(kind = "image")))
        assertEquals(LibraryGroup.Media, LibraryGroup.of(item(mime = "video/mp4")))
    }

    @Test fun everythingElseIsADocument() {
        assertEquals(LibraryGroup.Documents, LibraryGroup.of(item(mime = "application/pdf")))
        assertEquals(LibraryGroup.Documents, LibraryGroup.of(item()))
    }
}
