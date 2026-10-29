package io.github.nigelleong0703.juno.ui.uidoc

import io.github.nigelleong0703.juno.contract.FeedUiDoc
import io.github.nigelleong0703.juno.contract.UiBlock as WireBlock
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UiAnswersTest {
    private fun field(kind: String, required: Boolean = true, options: List<String> = emptyList()) =
        UiField(id = "f", label = "F", kind = kind, options = options, required = required, placeholder = null)

    @Test fun requiredEmptyIsAProblemOptionalEmptyIsNot() {
        assertEquals("Required", UiAnswers.problem(field("text"), "   "))
        assertNull(UiAnswers.problem(field("text", required = false), ""))
    }

    @Test fun numbersMatchTheServerPattern() {
        assertNull(UiAnswers.problem(field("number"), "-12.5"))
        assertEquals("Enter a number", UiAnswers.problem(field("number"), "12."))
        assertEquals("Enter a number", UiAnswers.problem(field("number"), "1e3"))
    }

    @Test fun datesMustBeRealCalendarDates() {
        assertNull(UiAnswers.problem(field("date"), "2026-02-28"))
        assertEquals("Enter a date as YYYY-MM-DD", UiAnswers.problem(field("date"), "2026-02-30"))
        assertEquals("Enter a date as YYYY-MM-DD", UiAnswers.problem(field("date"), "2026-2-3"))
        assertFalse(UiAnswers.isRealDate("2026-13-01"))
    }

    @Test fun selectMustBeOneOfTheOptions() {
        assertNull(UiAnswers.problem(field("select", options = listOf("a", "b")), "b"))
        assertEquals("Pick one", UiAnswers.problem(field("select", options = listOf("a", "b")), "c"))
    }

    @Test fun textIsCappedAt1000Characters() {
        assertNull(UiAnswers.problem(field("text"), "x".repeat(1000)))
        assertEquals("Must be at most 1000 characters", UiAnswers.problem(field("text"), "x".repeat(1001)))
    }

    @Test fun payloadIsTrimmedAndDropsEmptyOptionalAnswers() {
        val fields = listOf(field("text"), UiField("g", "G", "text", emptyList(), required = false, placeholder = null))
        val payload = UiAnswers.payload(fields, mapOf("f" to "  hello ", "g" to "   "))
        assertEquals(mapOf("f" to "hello"), payload)
    }

    @Test fun problemsReportEveryBadFieldById() {
        val fields = listOf(
            UiField("a", "A", "number", emptyList(), true, null),
            UiField("b", "B", "text", emptyList(), true, null),
        )
        assertTrue(UiAnswers.problems(fields, mapOf("a" to "x", "b" to "ok")).keys == setOf("a"))
        assertEquals(setOf("a", "b"), UiAnswers.problems(fields, emptyMap()).keys)
    }

    @Test fun multipleChoiceRoundTripsAsJsonArray() {
        val encoded = UiAnswers.encodeChoice(listOf("a", "b"))
        assertEquals("""["a","b"]""", encoded)
        assertEquals(listOf("a", "b"), UiAnswers.decodeChoice(encoded, multiple = true))
        assertEquals(listOf("a"), UiAnswers.decodeChoice("a", multiple = false))
        assertEquals(emptyList<String>(), UiAnswers.decodeChoice("not json", multiple = true))
    }

    @Test fun aTypedChatDocReadsThroughTheSameParser() {
        val doc = FeedUiDoc(
            version = 1.0,
            blocks = listOf(
                WireBlock(type = "choices", id = "c", multiple = false, options = listOf(
                    buildJsonObject { put("id", "a"); put("label", "Yes") }, buildJsonObject { put("id", "b"); put("label", "No") },
                )),
                WireBlock(type = "replies", options = listOf(JsonPrimitive("Sure"), JsonPrimitive("Later"))),
            ),
        ).parsed()
        assertEquals("c", UiAnswers.interactiveId(doc))
        assertEquals("No", UiAnswers.summary(doc, mapOf("c" to "b")))
        assertEquals(listOf("Sure", "Later"), doc.replies)
        assertNull(UiAnswers.interactiveId(FeedUiDoc(version = 1.0, blocks = listOf(WireBlock(type = "text", text = "hi"))).parsed()))
    }
}
