package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.Rule
import io.github.nigelleong0703.juno.contract.RunOrigin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RuleFormTest {
    private fun rule(id: String, source: String, scope: String = "action", subject: String? = null) =
        Rule(id = id, description = "Rule $id", source = source, scope = scope, subject = subject)

    @Test fun `a rule needs its text and its subject`() {
        assertNull(NewRuleDraft(description = "", subject = "browser.click").toInput())
        assertNull(NewRuleDraft(description = "Ask first", subject = "   ").toInput())
    }

    @Test fun `the input is trimmed and starts enabled`() {
        val input = NewRuleDraft(description = "  Don't email outsiders ", subject = " mail.send ", behavior = "ask").toInput()!!
        assertEquals("Don't email outsiders", input.description)
        assertEquals("mail.send", input.subject)
        assertEquals("action", input.scope)
        assertEquals("ask", input.behavior)
        assertEquals(true, input.enabled)
    }

    @Test fun `a recipient rule can only relax`() {
        val draft = NewRuleDraft(description = "Ana is fine", subject = "ana@example.com", behavior = "ask").withScope("recipient")
        assertEquals("auto", draft.behavior)
        assertEquals(listOf("auto"), behaviorsFor("recipient").map { it.first })
        assertEquals("auto", draft.toInput()!!.behavior)
    }

    @Test fun `switching back to action keeps the behaviour the recipient scope set`() {
        val draft = NewRuleDraft(description = "x", subject = "y", behavior = "handoff").withScope("recipient").withScope("action")
        assertEquals("auto", draft.behavior)
        assertEquals(4, behaviorsFor("action").size)
    }

    @Test fun `only user and team rules are custom and built-in ones are guardrails`() {
        val rules = listOf(
            rule("g", "builtin"), rule("u", "user"), rule("t", "team"),
            rule("d", "user", scope = "delegation"), rule("a", "agent_draft"),
        )
        assertEquals(listOf("g"), builtinRules(rules).map { it.id })
        assertEquals(listOf("u", "t"), customRules(rules).map { it.id })
    }

    @Test fun `an activity row says who started the work in the words all three apps use`() {
        assertEquals("Started by you", startedByLine(RunOrigin(type = "owner_message", conversationId = "c")))
        assertEquals("Started by a stranger on Telegram", startedByLine(RunOrigin(type = "channel", channel = "telegram", speaker = "stranger")))
        assertEquals("Started by you on Slack", startedByLine(RunOrigin(type = "channel", channel = "slack", speaker = "owner")))
        assertEquals("Started by a routine · Daily digest", startedByLine(RunOrigin(type = "routine", routineId = "r"), "Daily digest"))
        assertEquals("Started by a routine", startedByLine(RunOrigin(type = "routine", routineId = "r")))
        assertEquals("Started by the system · task done", startedByLine(RunOrigin(type = "system", wakeKind = "task_done")))
        assertEquals("Started by the system", startedByLine(RunOrigin(type = "system", wakeKind = "system")))
    }

    @Test fun `search matches the description or the subject`() {
        val rules = listOf(rule("1", "user", subject = "browser.click"), rule("2", "user", subject = "mail.send"))
        assertEquals(listOf("1"), filterRules(rules, "CLICK").map { it.id })
        assertEquals(2, filterRules(rules, "  ").size)
    }
}
