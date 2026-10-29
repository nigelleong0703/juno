package io.github.nigelleong0703.juno.state

import io.github.nigelleong0703.juno.contract.Connection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectorRulesTest {
    private fun connector(id: String, tier: String = "featured", category: String? = null, available: Boolean? = true, permission: String = "read_only") =
        ConnectorView(id = id, name = "Name $id", description = "Does $id things", tier = tier, category = category, icon = id,
            available = available != false, permission = permission, status = "disconnected")

    @Test fun `connectors the server cannot offer are not listed`() {
        val listed = ConnectorRules.listed(listOf(connector("a"), connector("b", available = false), connector("c", available = null)))
        assertEquals(listOf("a", "c"), listed.map { it.id })
    }

    @Test fun `a connector without a tier is featured`() {
        assertEquals("featured", ConnectorRules.tierOf(connector("a")))
        val tiers = listOf(connector("a", tier = "builtin"), connector("b"), connector("c", tier = "custom"))
        assertEquals(listOf("b"), ConnectorRules.inTier(tiers, "featured").map { it.id })
        assertEquals(listOf("a"), ConnectorRules.inTier(tiers, "builtin").map { it.id })
    }

    @Test fun `each tier shows eight rows until expanded or searching`() {
        val items = (1..10).map { connector("c$it") }
        assertEquals(8, ConnectorRules.visibleInTier(items, expanded = false, searching = false).size)
        assertEquals(10, ConnectorRules.visibleInTier(items, expanded = true, searching = false).size)
        assertEquals(10, ConnectorRules.visibleInTier(items, expanded = false, searching = true).size)
    }

    @Test fun `search matches name or description without case, and the category narrows`() {
        val files = connector("drive", category = "files")
        val mail = connector("mail", category = "productivity")
        assertTrue(ConnectorRules.matches(files, category = null, query = "DRIVE"))
        assertTrue(ConnectorRules.matches(mail, category = null, query = "things"))
        assertFalse(ConnectorRules.matches(mail, category = "files", query = ""))
        assertTrue(ConnectorRules.matches(files, category = "files", query = ""))
    }

    @Test fun `categories are distinct and sorted`() {
        val list = listOf(connector("a", category = "media"), connector("b", category = "files"), connector("c", category = "media"), connector("d"))
        assertEquals(listOf("files", "media"), ConnectorRules.categories(list))
    }

    @Test fun `a catalog connector without a permission is read only`() {
        assertEquals("read_only", ConnectorRules.catalogPermission(connector("a")))
        assertEquals("full", ConnectorRules.catalogPermission(connector("a", permission = "full")))
    }

    @Test fun `a custom connection without a permission is full`() {
        assertEquals("full", ConnectorRules.customPermission(Connection(id = "x")))
    }

    @Test fun `reconnect is offered for a lapsed or failed sign-in only`() {
        assertTrue(ConnectorRules.needsReconnect("needs_reauth"))
        assertTrue(ConnectorRules.needsReconnect("error"))
        assertFalse(ConnectorRules.needsReconnect("connected"))
        assertFalse(ConnectorRules.needsReconnect(null))
    }
}
