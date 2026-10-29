package io.github.nigelleong0703.juno.ui.uidoc

import io.github.nigelleong0703.juno.core.JunoJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UiDocParserTest {
    private fun doc(json: String): UiDoc = UiDocParser.parse(JunoJson.parseToJsonElement(json))

    @Test fun versionOneWithKnownBlocksIsRenderable() {
        val d = doc("""{"version":1,"blocks":[{"type":"text","text":"hi"}]}""")
        assertTrue(d.isRenderable)
    }

    @Test fun otherVersionsAreNotRenderable() {
        assertFalse(doc("""{"version":2,"blocks":[{"type":"text","text":"hi"}]}""").isRenderable)
        assertFalse(doc("""{"version":"1","blocks":[{"type":"text","text":"hi"}]}""").isRenderable)
        assertFalse(doc("""{"blocks":[{"type":"text","text":"hi"}]}""").isRenderable)
    }

    @Test fun emptyBlocksAreNotRenderable() {
        assertFalse(doc("""{"version":1,"blocks":[]}""").isRenderable)
    }

    @Test fun unknownBlockTypeMakesTheWholeDocNonRenderable() {
        val d = doc("""{"version":1,"text":"fallback","blocks":[{"type":"text","text":"a"},{"type":"hologram"}]}""")
        assertFalse(d.isRenderable)
        assertEquals("fallback", d.text)
    }

    @Test fun textNeedsANonEmptyString() {
        assertEquals(UiBlock.Unknown, UiDocParser.block(JunoJson.parseToJsonElement("""{"type":"text","text":""}""")))
    }

    @Test fun factsNeedEveryRowValid() {
        assertEquals(UiBlock.Unknown, UiDocParser.block(JunoJson.parseToJsonElement("""{"type":"facts","rows":[{"label":"a","value":"1"},{"label":"b"}]}""")))
        val ok = UiDocParser.block(JunoJson.parseToJsonElement("""{"type":"facts","rows":[{"label":"a","value":"1","emphasis":true}]}""")) as UiBlock.Facts
        assertEquals(listOf(UiFact("a", "1", emphasis = true)), ok.rows)
    }

    @Test fun itemsKeepOnlyHttpsImages() {
        val items = UiDocParser.block(JunoJson.parseToJsonElement(
            """{"type":"items","rows":[{"name":"Tea","quantity":2,"price":"$3","imageUrl":"http://x/a.png"},{"name":"Cup","imageUrl":"https://x/b.png"}],"total":{"label":"Total","value":"$9"}}""",
        )) as UiBlock.Items
        assertEquals(null, items.rows[0].imageUrl)
        assertEquals("https://x/b.png", items.rows[1].imageUrl)
        assertEquals(2, items.rows[0].quantity)
        assertEquals("Total", items.total?.label)
    }

    @Test fun tablePadsShortRowsAndCutsLongOnes() {
        val table = UiDocParser.block(JunoJson.parseToJsonElement(
            """{"type":"table","columns":["a","b"],"rows":[["1"],["2","3","4"]]}""",
        )) as UiBlock.Table
        assertEquals(listOf(listOf("1", ""), listOf("2", "3")), table.rows)
    }

    @Test fun tableNeedsTwoColumns() {
        assertEquals(UiBlock.Unknown, UiDocParser.block(JunoJson.parseToJsonElement("""{"type":"table","columns":["a"],"rows":[["1"]]}""")))
    }

    @Test fun noticeToneMustBeKnown() {
        assertEquals(UiBlock.Unknown, UiDocParser.block(JunoJson.parseToJsonElement("""{"type":"notice","tone":"danger","text":"x"}""")))
        assertEquals(UiBlock.Notice("warning", "x"), UiDocParser.block(JunoJson.parseToJsonElement("""{"type":"notice","tone":"warning","text":"x"}""")))
    }

    @Test fun linkMustBeHttps() {
        assertEquals(UiBlock.Unknown, UiDocParser.block(JunoJson.parseToJsonElement("""{"type":"link","url":"http://x","title":"t"}""")))
    }

    @Test fun groupWithAnUnknownInsideIsNotKnown() {
        val group = UiDocParser.block(JunoJson.parseToJsonElement(
            """{"type":"group","title":"g","blocks":[{"type":"text","text":"a"},{"type":"nope"}]}""",
        ))
        assertFalse(group.isKnown)
    }

    @Test fun groupWithChoicesIsNotKnown() {
        val group = UiDocParser.block(JunoJson.parseToJsonElement(
            """{"type":"group","blocks":[{"type":"choices","id":"c","options":[{"id":"a","label":"A"},{"id":"b","label":"B"}]}]}""",
        ))
        assertFalse(group.isKnown)
    }

    @Test fun repliesAreCappedAtThree() {
        val replies = UiDocParser.block(JunoJson.parseToJsonElement("""{"type":"replies","options":["a","b","c","d"]}""")) as UiBlock.Replies
        assertEquals(3, replies.options.size)
    }

    @Test fun choicesNeedAtLeastTwoValidOptions() {
        assertEquals(UiBlock.Unknown, UiDocParser.block(JunoJson.parseToJsonElement("""{"type":"choices","id":"c","options":[{"id":"a","label":"A"}]}""")))
        val choices = UiDocParser.block(JunoJson.parseToJsonElement(
            """{"type":"choices","id":"c","multiple":true,"options":[{"id":"a","label":"A","style":"primary"},{"id":"b","label":"B"}]}""",
        )) as UiBlock.Choices
        assertTrue(choices.multiple)
        assertEquals("default", choices.options[1].style)
        assertTrue(choices.isInteractive)
    }

    @Test fun fieldsDefaultToRequiredAndSelectNeedsOptions() {
        assertEquals(UiBlock.Unknown, UiDocParser.block(JunoJson.parseToJsonElement(
            """{"type":"fields","id":"f","fields":[{"id":"x","label":"X","kind":"select"}]}""",
        )))
        val fields = UiDocParser.block(JunoJson.parseToJsonElement(
            """{"type":"fields","id":"f","fields":[{"id":"x","label":"X","kind":"text"},{"id":"y","label":"Y","kind":"date","required":false}]}""",
        )) as UiBlock.Fields
        assertTrue(fields.fields[0].required)
        assertFalse(fields.fields[1].required)
    }

    @Test fun unknownFieldKindIsRejected() {
        assertEquals(UiBlock.Unknown, UiDocParser.block(JunoJson.parseToJsonElement(
            """{"type":"fields","id":"f","fields":[{"id":"x","label":"X","kind":"color"}]}""",
        )))
    }
}
